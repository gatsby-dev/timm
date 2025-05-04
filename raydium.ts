import { Connection, PublicKey, Keypair, SlotInfo, VersionedTransaction } from '@solana/web3.js';
import { getParsedTokenAccountsByOwner, getMint } from '@solana/spl-token';
import fs from 'fs/promises';
import dgram from 'dgram';
import path from 'path';
import dotenv from 'dotenv';
import { JupiterApiClient, QuoteResponse, SwapResponse } from '@jup-ag/api';
import bs58 from 'bs58';

dotenv.config();

let liveSolUsd = parseFloat(process.env.SOL_USD_PRICE || '125');
async function fetchSolUsdPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const json = await res.json();
    if (json?.solana?.usd && typeof json.solana.usd === 'number') {
      liveSolUsd = json.solana.usd;
    }
  } catch (e) {
    console.warn(`⚠️ Failed to fetch SOL/USD price:`, e);
  }
}
setInterval(fetchSolUsdPrice, 60_000);
fetchSolUsdPrice();

const ENABLE_TPU_SEND = process.env.ENABLE_TPU_SEND === 'true';
const DRY_RUN = process.env.DRY_RUN === 'true';

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

const RAYDIUM_AMM_PROGRAM_ID = new PublicKey('RVKd61ztZW9MqhpFz2B5C7G5kHk9wP5oR9a4UxJR6cm');
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const WEBSOCKET_URL = process.env.WS_URL || 'ws://127.0.0.1:8900';
const connection = new Connection(RPC_URL, {
  wsEndpoint: WEBSOCKET_URL,
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
});
const baseToken = 'So11111111111111111111111111111111111111112';
const minLiquidityUSD = 6000;
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY || ''));
const walletPublicKey = new PublicKey(wallet.publicKey);
const MIN_WSOL_BALANCE_SOL = parseFloat(process.env.MIN_WSOL_BALANCE_SOL || '0.001');
const DESIRED_PROFIT_PERCENT = parseFloat(process.env.DESIRED_PROFIT_PERCENT || '3');

const uniquePools = new Set<string>();
const freezeCache = new Map<string, boolean>();
let totalProfit = 0;
let successfulTrades = 0;
let jupiterApi: JupiterApiClient;
let latestSlot = 0;
let currentLeader: string | null = null;

function timestamp() {
  return new Date().toISOString();
}

function isLikelyPoolAccount(data: Buffer): boolean {
  return data.length >= 624;
}

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error(`❌ Error: PRIVATE_KEY environment variable is not set. Exiting.`);
    process.exit(1);
  }

  jupiterApi = new JupiterApiClient({ connection });

  await checkLocalServices();
  console.log(`⏳ Initializing Jupiter and watching Raydium pools...`);

  connection.onSlotChange(async (slotInfo: SlotInfo) => {
    latestSlot = slotInfo.slot;
    try {
      const leaders = await connection.getSlotLeaders(latestSlot, 1);
      currentLeader = leaders[0];
    } catch (e) {
      console.warn(`⚠️ Failed to get current leader:`, e);
      currentLeader = null;
    }

    try {
      const latestBlockhash = await connection.getLatestBlockhash('finalized');
      blockhashCache.set('latest', latestBlockhash.blockhash);
    } catch (error) {
      console.warn(`⚠️ Error fetching latest blockhash:`, error);
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
          console.log(`⛔ Skipping pool ${accountId} because at least one token has freeze authority`);
          await logSkipped('freezable token', accountId, mintA, mintB, liquidity);
          return;
        }
      }

      uniquePools.add(accountId);
      console.log(` New pool ${accountId} | MintA: ${mintA}, MintB: ${mintB} | Liquidity: $${liquidity}`);

      const [try1, try2] = await Promise.all([
        simulateBuySell(baseToken, mintA, true),
        simulateBuySell(baseToken, mintB, true),
      ]);

      const profitableTrades = [try1, try2].filter(Boolean).filter(best => best!.netProfitPercent

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
    console.warn(`⚠️ Error checking freezeAuthority for ${mintAddress}: ${err}`);
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
  const slippageBps = 100;

  try {
    const quoteResponseBuy = await jupiterApi.quoteGet({
      inputMint: mintBuy,
      outputMint: mintSell,
      amount: inputAmount.toString(),
      slippageBps,
    });

    const routeBuy = quoteResponseBuy.data?.[0];
    if (!routeBuy) return null;

    const outputAmountBuy = parseInt(routeBuy.outAmount);
    const inputAmountSolBuy = parseInt(routeBuy.inAmount);
    const profitPercentBuy = ((outputAmountBuy - inputAmountSolBuy) / inputAmountSolBuy) * 100;
    const profitUSDBuy = (outputAmountBuy - inputAmountSolBuy) / Math.pow(10, 9) * SOL_USD;

    if (simulateSellBack) {
      const quoteResponseSell = await jupiterApi.quoteGet({
        inputMint: mintSell,
        outputMint: baseToken,
        amount: outputAmountBuy.toString(),
        slippageBps,
      });

      const routeSell = quoteResponseSell.data?.[0];
      if (!routeSell) return null;

      const outputAmountSell = parseInt(routeSell.outAmount);
      const inputAmountSell = parseInt(routeSell.inAmount);
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
  } catch (error) {
    console.warn(`⚠️ Error simulating buy/sell for ${mintBuy}-${mintSell}:`, error);
    return null;
  }
}

async function buyAndSell(route: any, profitSol: number, profitUSD: number) {
  const isDryRun = process.env.DRY_RUN === 'true';

  if (isDryRun) {
    console.log(`⚠️ DRY RUN: Profitable trade opportunity found!`);
    console.log(`⚠️ DRY RUN: Would buy ${parseInt(route.inAmount) / Math.pow(10, route.inMintDecimals)} ${route.inMint} and sell ${parseInt(route.outAmount) / Math.pow(10, route.outMintDecimals)} ${route.outMint}`);
    console.log(`⚠️ DRY RUN: Estimated Profit: $${profitUSD.toFixed(2)} | SOL: ${(profitSol).toFixed(6)}`);
    await fs.appendFile('dry_run.txt', `DRY RUN: Profit: $${profitUSD.toFixed(2)} | SOL: ${(profitSol).toFixed(6)} | Buy Mint: ${route.inMint} | Sell Mint: ${route.outMint}\n`).catch(() => {});
    return;
  }

  try {
    const before = Date.now();
    const latestBlockhash = blockhashCache.get('latest', BLOCKHASH_CACHE_TTL_MS);
    if (!latestBlockhash) {
      console.warn(`⚠️ Could not retrieve latest blockhash from cache. Falling back to live fetch.`);
      const fetchedBlockhash = await connection.getLatestBlockhash('finalized');
      // @ts-ignore
      txBuilder.recentBlockhash = fetchedBlockhash.blockhash;
    } else {
      // @ts-ignore
      txBuilder.recentBlockhash = latestBlockhash;
    }

    const swapResponse = await jupiterApi.swapPost({
      quoteResponse: route,
      userPublicKey: walletPublicKey.toBase58(),
      wrapUnwrapSol: false,
    });

    const swapTransactionBuf = Buffer.from(swapResponse.data.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    const serializedTransaction = transaction.serialize();

    const txBase64 = serializedTransaction.toString('base64');
    let txid = '';

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

    if (ENABLE_TPU_SEND) {
      const localTpuAddress = '127.0.0.1';
      const localTpuPort = 8001;
      const socket = dgram.createSocket('udp4');
      socket.send(serializedTransaction, 0, serializedTransaction.length, localTpuPort, localTpuAddress, (err) => {
        console.log(` Attempted send to local TPU: ${localTpuAddress}:${localTpuPort}`);
        if (err) console.warn(`⚠️ Failed to send to local TPU: ${err}`);
        socket.close();
      });
    }

    const enableExternalTpu = process.env.ENABLE_EXTERNAL_TPU === 'true';
    const primaryTpuEndpoint = process.env.PRIMARY_TPU_ENDPOINT;

    if (enableExternalTpu && primaryTpuEndpoint) {
      const socket = dgram.createSocket('udp4');
      socket.send(serializedTransaction, 0, serializedTransaction.length, 8001, primaryTpuEndpoint.split(':')[0], (err) => {
        console.log(` Attempted send to primary TPU: ${primaryTpuEndpoint}:8001`);
        if (err) console.warn(`⚠️ Failed to send to primary TPU: ${err}`);
        socket.close();
        if (process.env.SECONDARY_TPU_ENDPOINT && err) {
          const retrySocket = dgram.createSocket('udp4');
          retrySocket.send(serializedTransaction, 0, serializedTransaction.length, 8001, process.env.SECONDARY_TPU_ENDPOINT.split(':')[0], (retryErr) => {
            console.log(` Attempted send to secondary TPU: ${process.env.SECONDARY_TPU_ENDPOINT}:8001`);
            if (retryErr) console.warn(`⚠️ Failed to send to secondary TPU: ${retryErr}`);
            retrySocket.close();
          });
        }
      });
    } else if (ENABLE_TPU_SEND && currentLeader) {
      const tpuAddress = `${currentLeader}`.replace('http://', '').replace('https://', '').split(':')[0];
      const socket = dgram.createSocket('udp4');
      socket.send(serializedTransaction, 0, serializedTransaction.length, 8001, tpuAddress, (err) => {
        console.log(` Attempted send to leader TPU: ${tpuAddress}:8001`);
        if (err) console.warn(`⚠️ Failed to send to leader TPU: ${err}`);
        socket.close();
      });
    }

    const after = Date.now();
    const latencyMs = after - before;
    totalProfit += profitSol;
    successfulTrades++;

    const tokenPair = `${route.inMint} -> ${route.outMint}`;
    console.log(`✅ Trade executed! Tx: ${txid}`);
    console.log(` Profit: $${profitUSD.toFixed(2)} | SOL: ${(profitSol).toFixed(6)}`);
    console.log(`燐 Win rate: ${(successfulTrades > 0 ? 100 : 0).toFixed(2)}% | Avg Profit: $${(totalProfit / successfulTrades || 0).toFixed(4)}`);
    console.log(`⏱️ Execution latency: ${latencyMs}ms |  Running profit total: $${totalProfit.toFixed(2)}`);

    await fs.appendFile('latency.txt', `Tx: ${txid} | Latency: ${latencyMs}ms | Profit: $${profitSol.toFixed(6)} | ProfitUSD: $${profitUSD.toFixed(2)}\n`).catch(() => {});
    await fs.appendFile('success.txt', `SUCCESS: ${txid} | Profit: $${profitUSD.toFixed(2)} | Pair: ${tokenPair}\n`).catch(() => {});
  } catch (err: any) {
    console.warn(`❌ Execution failed: ${err}`);
    if (err?.message?.includes('Transaction was not confirmed in')) {
      console.warn(`⚠️ Transaction confirmation timeout for txid: ${txid}`);
    } else if (err?.message?.includes('AccountNotFound')) {
      console.warn(`⚠️ Account not found error for txid: ${txid}`);
    } else if (err?.message?.includes('Blockhash not found')) {
      console.warn(`⚠️ Blockhash not found error.`);
    } else if (err?.message?.includes('failed to send transaction: SendTransactionPreflightFailure')) {
      console.warn(`⚠️ Transaction preflight failure for txid: ${txid}`);
    }
    console.error(` Full error details:`, err);
  }
}

async function checkLocalServices() {
  console.log(`喙 Checking local service connectivity and wallet balance...`);

  try {
    const health = await connection.getHealth();
    console.log(`✅ Solana RPC status: ${health}`);
    if (health !== 'ok') {
      console.warn(`⚠️ Solana RPC is not 'ok', bot might not function correctly.`);
    }
  } catch (error) {
    console.error(`❌ Error connecting to Solana RPC at ${RPC_URL}:`, error);
    process.exit(1);
  }

  try {
    const response = await fetch(process.env.JUPITER_ROUTE_API || 'http://127.0.0.1:8080');
    if (!response.ok) {
      console.warn(`⚠️ Jupiter API at ${process.env.JUPITER_ROUTE_API || 'http://127.0.0.1:8080'} returned status: ${response.status} - ${response.statusText}`);
    } else {
      console.log(`✅ Jupiter API is reachable.`);
    }
  } catch (error) {
    console.error(`❌ Error connecting to Jupiter API at ${process.env.JUPITER_ROUTE_API || 'http://127.0.0.1:8080'}:`, error);
  }

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

    console.log(`✅ WSOL Balance: ${wsolBalanceSOL.toFixed(9)} SOL`);

    if (wsolBalanceSOL < MIN_WSOL_BALANCE_SOL) {
      console.warn(`⚠️ WARNING: WSOL balance is below the minimum threshold (${MIN_WSOL_BALANCE_SOL} SOL). Bot might not be able to execute trades.`);
    }

  } catch (error) {
    console.error(`❌ Error checking WSOL balance:`, error);
  }
}

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error(`❌ Error: PRIVATE_KEY environment variable is not set. Exiting.`);
    process.exit(1);
  }

  jupiterApi = new JupiterApiClient({ connection });

  await checkLocalServices();
  console.log(`⏳ Initializing Jupiter and watching Raydium pools...`);

  connection.onSlotChange(async (slotInfo: SlotInfo) => {
    latestSlot = slotInfo.slot;
    try {
      const leaders = await connection.getSlotLeaders(latestSlot, 1);
      currentLeader = leaders[0];
    } catch (e) {
      console.warn(`⚠️ Failed to get current leader:`, e);
      currentLeader = null;
    }

    try {
      const latestBlockhash = await connection.getLatestBlockhash('finalized');
      blockhashCache.set('latest', latestBlockhash.blockhash);
    } catch (error) {
      console.warn(`⚠️ Error fetching latest blockhash:`, error);
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
          console.log(`⛔ Skipping pool ${accountId} because at least one token has freeze authority`);
          await logSkipped('freezable token', accountId, mintA, mintB, liquidity);
          return;
        }
      }

      uniquePools.add(accountId);
      console.log(` New pool ${accountId} | MintA: ${mintA}, MintB: ${mintB} | Liquidity: $${liquidity}`);

      const [try1, try2] = await Promise.all([
        simulateBuySell(baseToken, mintA, true),
        simulateBuySell(baseToken, mintB, true),
      ]);

      const profitableTrades = [try1, try2].filter(Boolean).filter(best => best!.netProfitPercent >= DESIRED_PROFIT_PERCENT);
      const bestImmediateRoundTrip = profitableTrades.sort((a, b) => b!.netProfitPercent - a!.netProfitPercent)[0];

      if (bestImmediateRoundTrip) {
        console.log(`⚡️ Profitable round trip (buy & sell) opportunity: ${bestImmediateRoundTrip.netProfitPercent.toFixed(2)}% — Slot: ${latestSlot} — Executing immediate buy and sell...`);
        await buyAndSell(bestImmediateRoundTrip.routeBuy, bestImmediateRoundTrip.outputAmountBuy - bestImmediateRoundTrip.inputAmountSolBuy, bestImmediateRoundTrip.profitUSDBuy);
        if (bestImmediateRoundTrip.routeSell) {
          await buyAndSell(bestImmediateRoundTrip.routeSell, bestImmediateRoundTrip.outputAmountSell - bestImmediateRoundTrip.inputAmountSell, bestImmediateRoundTrip.netProfitUSD);
        } else {
          console.warn(`⚠️ No sell route found for immediate sell back.`);
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

// Placeholder for estimateLiquidity - you need to implement this function
function estimateLiquidity(buffer: Buffer): number {
  // Implement your liquidity estimation logic here based on the buffer data
  return 10000; // Replace with actual logic
}
