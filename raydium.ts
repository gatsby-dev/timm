import { Connection, PublicKey, Keypair, SlotInfo } from '@solana/web3.js';
import { getParsedTokenAccountsByOwner, getMint } from '@solana/spl-token';
import fs from 'fs/promises';
import dgram from 'dgram';
import path from 'path';
import dotenv from 'dotenv';
import { Jupiter, RouteInfo } from '@jup-ag/core';
import bs58 from 'bs58';

dotenv.config();

// === Dynamic SOL/USD price tracker ===
let liveSolUsd = parseFloat(process.env.SOL_USD_PRICE || '125');
async function fetchSolUsdPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const json = await res.json();
    if (json?.solana?.usd && typeof json.solana.usd === 'number') {
      liveSolUsd = json.solana.usd;
    } else {
      console.warn(`[${timestamp()}] ⚠️ Invalid SOL/USD price received, keeping previous value: $${liveSolUsd}`);
    }
  } catch (e) {
    console.warn(`[${timestamp()}] ⚠️ Failed to fetch SOL/USD price:`, e);
  }
}
setInterval(fetchSolUsdPrice, 60_000);
fetchSolUsdPrice();

const ENABLE_TPU_SEND = process.env.ENABLE_TPU_SEND === 'true';

const TTL = (key: string, fallback: number) => parseInt(process.env[key] || `${fallback}`);
const CACHE_TTL_SIMULATE_JUPITER = TTL('CACHE_TTL_SIMULATE_JUPITER', 2);
const CACHE_TTL_TOKEN_METADATA = TTL('CACHE_TTL_TOKEN_METADATA', 60);
const CACHE_TTL_ACCOUNT_INFO = TTL('CACHE_TTL_ACCOUNT_INFO', 20);
const BLOCKHASH_CACHE_TTL_MS = 500;

const simulateCache = new Map<string, { timestamp: number, result: any }>();
const tokenMetadataCache = createCache<any>();
const accountInfoCache = createCache<any>();
const blockhashCache = createCache<string>();

const createCache = <T>() => {
  const store = new Map<string, { value: T; timestamp: number }>();
  return {
    get: (key: string, ttl: number): T | undefined => {
      const entry = store.get(key);
      if (!entry || Date.now() - entry.timestamp > ttl) return undefined;
      return entry.value;
    },
    set: (key: string, value: T) => {
      store.set(key, { value, timestamp: Date.now() });
    },
    has: (key: string) => store.has(key)
  };
};

// === CONFIG ===
const RAYDIUM_AMM_PROGRAM_ID = new PublicKey('RVKd61ztZW9MqhpFz2B5C7G5kHk9wP5oR9a4UxJR6cm');
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const WEBSOCKET_URL = process.env.WS_URL || 'ws://127.0.0.1:8900';
const connection = new Connection(RPC_URL, {
  wsEndpoint: WEBSOCKET_URL,
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
});
const baseToken = 'So11111111111111111111111111111111111111112'; // WSOL
const minLiquidityUSD = 6000;
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY || ''));
const walletPublicKey = new PublicKey(wallet.publicKey);
const MIN_WSOL_BALANCE_SOL = parseFloat(process.env.MIN_WSOL_BALANCE_SOL || '0.001');
const DESIRED_PROFIT_PERCENT = parseFloat(process.env.DESIRED_PROFIT_PERCENT || '3');

const uniquePools = new Set<string>();
const freezeCache = new Map<string, boolean>();
let totalProfit = 0;
let successfulTrades = 0;
let jupiter: Jupiter;
let latestSlot = 0;
let currentLeader: string | null = null;

function timestamp() {
  return new Date().toISOString();
}

function isLikelyPoolAccount(data: Buffer): boolean {
  return data.length >= 624;
}

function extractMints(data: Buffer): [string, string] | null {
  try {
    const mintA = new PublicKey(data.slice(72, 104)).toBase58();
    const mintB = new PublicKey(data.slice(104, 136)).toBase58();
    return [mintA, mintB];
  } catch {
    return null;
  }
}

function getDailyLogFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(__dirname, `skipped-${date}.log`);
}

async function logSkipped(reason: string, accountId: string, mintA: string, mintB: string, liquidity: number) {
  const logEntry = `[${timestamp()}] SKIPPED: ${reason} | Pool: ${accountId} | MintA: ${mintA} | MintB: ${mintB} | Liquidity: $${liquidity}\n`;
  const logFile = getDailyLogFile();
  await fs.appendFile(logFile, logEntry).catch(() => {});
}

async function isNonFreezable(mintAddress: string): Promise<boolean> {
  if (freezeCache.has(mintAddress)) return freezeCache.get(mintAddress)!;
  const cached = accountInfoCache.get(mintAddress, CACHE_TTL_ACCOUNT_INFO);
  if (cached !== undefined) return cached;
  try {
    const mint = await getMint(connection, new PublicKey(mintAddress));
    const result = mint.freezeAuthority === null;
    freezeCache.set(mintAddress, result);
    accountInfoCache.set(mintAddress, result);
    return result;
  } catch (err) {
    console.warn(`[${timestamp()}] ⚠️ Error checking freezeAuthority for ${mintAddress}: ${err}`);
    freezeCache.set(mintAddress, false);
    accountInfoCache.set(mintAddress, false);
    return false;
  }
}

async function simulateBuySell(mintBuy: string, mintSell: string, simulateSellBack: boolean = false) {
  const cacheKey = `${mintBuy}_${mintSell}${simulateSellBack ? `_${baseToken}` : ''}`;
  const cached = simulateCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.timestamp < CACHE_TTL_SIMULATE_JUPITER * 1000) {
    return cached.result;
  }
  const SOL_USD = liveSolUsd;
  const inputAmount = Math.floor((parseFloat(process.env.QUOTE_AMOUNT || '0.01') * 1_000_000_000));

  const routesBuy = await jupiter.computeRoutes({
    inputMint: new PublicKey(mintBuy),
    outputMint: new PublicKey(mintSell),
    amount: inputAmount,
    slippage: 1,
    forceFetch: true,
  });

  const routeBuy = routesBuy.routes?.[0] as RouteInfo;
  if (!routeBuy) return null;

  const outputAmountBuy = routeBuy.outAmount;
  const inputAmountSolBuy = routeBuy.inAmount;
  const profitPercentBuy = ((outputAmountBuy - inputAmountSolBuy) / inputAmountSolBuy) * 100;
  const profitUSDBuy = (outputAmountBuy - inputAmountSolBuy) / Math.pow(10, 9) * SOL_USD;

  if (simulateSellBack) {
    const routesSell = await jupiter.computeRoutes({
      inputMint: new PublicKey(mintSell),
      outputMint: new PublicKey(baseToken),
      amount: outputAmountBuy,
      slippage: 1,
      forceFetch: true,
    });

    const routeSell = routesSell.routes?.[0] as RouteInfo;
    if (!routeSell) return null;

    const outputAmountSell = routeSell.outAmount;
    const inputAmountSell = routeSell.inAmount;
    const netProfitSol = outputAmountSell - inputAmount;
    const netProfitPercent = (netProfitSol / inputAmount) * 100;
    const netProfitUSD = netProfitSol / Math.pow(10, 9) * SOL_USD;

    const result = { routeBuy, routeSell, profitPercentBuy, profitUSDBuy, outputAmountBuy, inputAmountSolBuy, outputAmountSell, inputAmountSell, netProfitSol, netProfitPercent, netProfitUSD };
    simulateCache.set(cacheKey, { timestamp: now, result });
    return result;
  } else {
    const result = { routeBuy, profitPercentBuy, profitUSDBuy, outputAmountBuy, inputAmountSolBuy };
    simulateCache.set(cacheKey, { timestamp: now, result });
    return result;
  }
}

async function buyAndSell(route: RouteInfo, profitSol: number, profitUSD: number) {
  try {
    const before = Date.now();
    const latestBlockhash = blockhashCache.get('latest', BLOCKHASH_CACHE_TTL_MS);
    if (!latestBlockhash) {
      console.warn(`[${timestamp()}] ⚠️ Could not retrieve latest blockhash from cache. Falling back to live fetch.`);
      const fetchedBlockhash = await connection.getLatestBlockhash('finalized');
      txBuilder.recentBlockhash = fetchedBlockhash.blockhash;
    } else {
      txBuilder.recentBlockhash = latestBlockhash;
    }

    const txBuilder = await jupiter.exchange({ route, userPublicKey: wallet.publicKey });
    const signed = await txBuilder.prepare({ signers: [wallet] });
    const serialized = signed.serialize();

    const txBase64 = serialized.toString('base64');
    let txid = '';

    // Send via raw JSON-RPC (for logging and backup)
    const rpcResponse = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          txBase64,
          {
            skipPreflight: true,
            preflightCommitment: 'processed',
            maxRetries: 0,
          },
        ],
      }),
    });

    const rpcJson = await rpcResponse.json();
    if (rpcJson.error) throw new Error(JSON.stringify(rpcJson.error));
    txid = rpcJson.result;

    // Optional External TPU Send (Now Prioritizing Local)
    const enableExternalTpu = process.env.ENABLE_EXTERNAL_TPU === 'true';
    const primaryTpuEndpoint = process.env.PRIMARY_TPU_ENDPOINT;

    if (enableExternalTpu && primaryTpuEndpoint) {
      const socket = dgram.createSocket('udp4');
      socket.send(serialized, 0, serialized.length, 8001, primaryTpuEndpoint.split(':')[0], (err) => {
        console.log(`[${timestamp()}]  Attempted send to primary TPU: ${primaryTpuEndpoint}:8001`);
        if (err) console.warn(`[${timestamp()}] ⚠️ Failed to send to primary TPU: ${err}`);
        socket.close();
        if (process.env.SECONDARY_TPU_ENDPOINT && err) {
          const retrySocket = dgram.createSocket('udp4');
          retrySocket.send(serialized, 0, serialized.length, 8001, process.env.SECONDARY_TPU_ENDPOINT.split(':')[0], (retryErr) => {
            console.log(`[${timestamp()}]  Attempted send to secondary TPU: ${process.env.SECONDARY_TPU_ENDPOINT}:8001`);
            if (retryErr) console.warn(`[${timestamp()}] ⚠️ Failed to send to secondary TPU: ${retryErr}`);
            retrySocket.close();
          });
        }
      });
    } else if (ENABLE_TPU_SEND && currentLeader) { // Fallback to leader-derived if external not enabled
      const tpuAddress = `${currentLeader}`.replace('http://', '').replace('https://', '').split(':')[0];
      const socket = dgram.createSocket('udp4');
      socket.send(serialized, 0, serialized.length, 8001, tpuAddress, (err) => {
        console.log(`[${timestamp()}]  Attempted send to leader TPU: ${tpuAddress}:8001`);
        if (err) console.warn(`[${timestamp()}] ⚠️ Failed to send to leader TPU: ${err}`);
        socket.close();
      });
    }

    const after = Date.now();
    const latencyMs = after - before;
    totalProfit += profitSol;
    successfulTrades++;

    const tokenPair = `${route.marketInfo.inputMint.toBase58()} -> ${route.marketInfo.outputMint.toBase58()}`;
    console.log(`[${timestamp()}] ✅ Trade executed! Tx: ${txid}`);
    console.log(`[${timestamp()}]  Profit: $${profitUSD.toFixed(2)} | SOL: ${(profitSol).toFixed(6)}`);
    console.log(`[${timestamp()}] 燐 Win rate: ${(successfulTrades > 0 ? 100 : 0).toFixed(2)}% | Avg Profit: $${(totalProfit / successfulTrades || 0).toFixed(4)}`);
    console.log(`[${timestamp()}] ⏱️ Execution latency: ${latencyMs}ms |  Running profit total: $${totalProfit.toFixed(2)}`);

    await fs.appendFile('latency.txt', `[${timestamp()}] Tx: ${txid} | Latency: ${latencyMs}ms | Profit: $${profitSol.toFixed(6)} | ProfitUSD: $${profitUSD.toFixed(2)}\n`).catch(() => {});
    await fs.appendFile('success.txt', `[${timestamp()}] SUCCESS: ${txid} | Profit: $${profitUSD.toFixed(2)} | Pair: ${tokenPair}\n`).catch(() => {});
  } catch (err: any) {
    console.warn(`[${timestamp()}] ❌ Execution failed: ${err}`);
    if (err?.message?.includes('Transaction was not confirmed in')) {
      console.warn(`[${timestamp()}] ⚠️ Transaction confirmation timeout for txid: ${txid}`);
      // Consider very short retry logic here if needed
    } else if (err?.message?.includes('AccountNotFound')) {
      console.warn(`[${timestamp()}] ⚠️ Account not found error for txid: ${txid}`);
    } else if (err?.message?.includes('Blockhash not found')) {
      console.warn(`[${timestamp()}] ⚠️ Blockhash not found error.`);
      // This might indicate an issue with your blockhash caching or RPC connection
    } else if (err?.message?.includes('failed to send transaction: SendTransactionPreflightFailure')) {
      console.warn(`[${timestamp()}] ⚠️ Transaction preflight failure for txid: ${txid}`);
      // This could be due to insufficient funds, invalid account state, etc.
    }
    // Log the full error for debugging
    console.error(`[${timestamp()}]  Full error details:`, err);
  }
}

async function checkLocalServices() {
  console.log(`[${timestamp()}] 喙 Checking local service connectivity and wallet balance...`);

  // Check Solana RPC
  try {
    const health = await connection.getHealth();
    console.log(`[${timestamp()}] ✅ Solana RPC status: ${health}`);
    if (health !== 'ok') {
      console.warn(`[${timestamp()}] ⚠️ Solana RPC is not 'ok', bot might not function correctly.`);
    }
  } catch (error) {
    console.error(`[${timestamp()}] ❌ Error connecting to Solana RPC at ${RPC_URL}:`, error);
    process.exit(1); // Exit the bot if RPC is not available
  }

  // Check Jupiter API
  try {
    const response = await fetch(process.env.JUPITER_ROUTE_API || 'http://127.0.0.1:8080');
    if (!response.ok) {
      console.warn(`[${timestamp()}] ⚠️ Jupiter API at ${process.env.JUPITER_ROUTE_API || 'http://127.0.0.1:8080'} returned status: ${response.status} - ${response.statusText}`);
      // Optionally decide if this is critical enough to exit
    } else {
      console.log(`[${timestamp()}] ✅ Jupiter API is reachable.`);
    }
  } catch (error) {
    console.error(`[${timestamp()}] ❌ Error connecting to Jupiter API at ${process.env.JUPITER_ROUTE_API || 'http://127.0.0.1:8080'}:`, error);
    // Optionally decide if this is critical enough to exit
  }

  // Check WSOL Balance
  try {
    const tokenAccounts = await getParsedTokenAccountsByOwner(
      connection,
      walletPublicKey,
      { mint: new PublicKey(baseToken) }
    );

    let wsolBalanceSOL = 0;
    if (tokenAccounts.value.length > 0) {
      const accountInfo = tokenAccounts.value[0].account?.data?.parsed?.info;
      if (accountInfo?.tokenAmount?.uiAmount !== undefined) {
        wsolBalanceSOL = accountInfo.tokenAmount.uiAmount;
      }
    }

    console.log(`[${timestamp()}] ✅ WSOL Balance: ${wsolBalanceSOL.toFixed(9)} SOL`);

    if (wsolBalanceSOL < MIN_WSOL_BALANCE_SOL) {
      console.warn(`[<span class="math-inline">\{timestamp\(\)\}\] ⚠️ WARNING\: WSOL balance is below the minimum threshold \(</span>{MIN_WSOL_BALANCE_SOL} SOL). Bot might not be able to execute trades.`);
      // Optionally, you could decide to exit the bot here if the balance is too low on startup
      // process.exit(1);
    }

  } catch (error) {
    console.error(`[${timestamp()}] ❌ Error checking WSOL balance:`, error);
    // Optionally handle the error, perhaps by exiting or logging a severe warning
    // process.exit(1);
  }
}

async function main() {
  // Ensure PRIVATE_KEY is set before proceeding with walletPublicKey
  if (!process.env.PRIVATE_KEY) {
    console.error(`[${timestamp()}] ❌ Error: PRIVATE_KEY environment variable is not set. Exiting.`);
    process.exit(1);
  }

  await checkLocalServices();
  console.log(`[${timestamp()}] ⏳ Initializing Jupiter and watching Raydium pools...`);

  connection.onSlotChange(async (slotInfo: SlotInfo) => {
    latestSlot = slotInfo.slot;
    try {
      const leaders = await connection.getSlotLeaders(latestSlot, 1);
      currentLeader = leaders[0];
    } catch (e) {
      console.warn(`[${timestamp()}] ⚠️ Failed to get current leader:`, e);
      currentLeader = null;
    }

    try {
      const latestBlockhash = await connection.getLatestBlockhash('finalized');
      blockhashCache.set('latest', latestBlockhash.blockhash);
    } catch (error) {
      console.warn(`[${timestamp()}] ⚠️ Error fetching latest blockhash:`, error);
    }
  });

  connection.onProgramAccountChange(
    RAYDIUM_AMM_PROGRAM_ID,
    async (info) => {
      const accountId = info.accountId.toBase58();
      const buffer = info.accountInfo.data;
      if (!isLikelyPoolAccount(buffer) || uniquePools.has(accountId)) return;

      const liquidity = estimateLiquidity(buffer);
      if (liquidity < minLiquidityUSD) return;

      const mints = extractMints(buffer);
      if (!mints) return;
      const [mintA, mintB] = mints;

      const allowNonFreezableOnly = process.env.ALLOW_NON_FREEZABLE_ONLY === 'true';

      if (allowNonFreezableOnly) {
        const [nonFreezableA, nonFreezableB] = await Promise.all([
          isNonFreezable(mintA),
          isNonFreezable(mintB),
        ]);

        if (!nonFreezableA || !nonFreezableB) {
          console.log(`[${timestamp()}] ⛔ Skipping pool ${accountId} because at least one token has freeze authority`);
          await logSkipped('freezable token', accountId, mintA, mintB, liquidity);
          return;
        }
      }

      uniquePools.add(accountId);
      console.log(`[${timestamp()}]  New pool ${accountId} | MintA: ${mintA}, MintB: ${mintB} | Liquidity: $${liquidity}`);

      const [try1, try2] = await Promise.all([
        simulateBuySell(baseToken, mintA, true), // Simulate round trip for Mint A
        simulateBuySell(baseToken, mintB, true), // Simulate round trip for Mint B
      ]);

      const profitableTrades = [try1, try2].filter(Boolean).filter(best => best!.netProfitPercent >= DESIRED_PROFIT_PERCENT);
      const bestImmediateRoundTrip = profitableTrades.sort((a, b) => b!.netProfitPercent - a!.netProfitPercent)[0];

      if (bestImmediateRoundTrip) {
        console.log(`[${timestamp()}] ⚡️ Profitable round trip (buy & sell) opportunity: ${bestImmediateRoundTrip.netProfitPercent.toFixed(2)}% — Slot: ${latestSlot} — Executing immediate buy and sell...`);
        // Execute Buy
        await buyAndSell(bestImmediateRoundTrip.routeBuy, bestImmediateRoundTrip.outputAmountBuy - bestImmediateRoundTrip.inputAmountSolBuy, bestImmediateRoundTrip.profitUSDBuy);
        // Execute Sell Immediately After
        if (bestImmediateRoundTrip.routeSell) {
          await buyAndSell(bestImmediateRoundTrip.routeSell, bestImmediateRoundTrip.outputAmountSell - bestImmediateRoundTrip.inputAmountSell, bestImmediateRoundTrip.netProfitUSD);
        } else {
          console.warn(`[${timestamp()}] ⚠️ No sell route found for immediate sell back.`);
        }
        return;
      } else {
        await logSkipped('not profitable on round trip', accountId, mintA, mintB, liquidity);
        return;
      }
    },
    'confirmed'
  );
}

main().catch(console.error);
