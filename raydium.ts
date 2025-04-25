import { Connection, PublicKey, Keypair, SlotInfo } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
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
const CACHE_TTL_SIMULATE_JUPITER = TTL('CACHE_TTL_SIMULATE_JUPITER', 30);
const CACHE_TTL_TOKEN_METADATA = TTL('CACHE_TTL_TOKEN_METADATA', 1000);
const CACHE_TTL_ACCOUNT_INFO = TTL('CACHE_TTL_ACCOUNT_INFO', 400);

const simulateCache = new Map<string, { timestamp: number, result: any }>();

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

const tokenMetadataCache = createCache<any>();
const accountInfoCache = createCache<any>();
const blockhashCache = createCache<string>();

// === CONFIG ===
const RAYDIUM_AMM_PROGRAM_ID = new PublicKey('RVKd61ztZW9MqhpFz2B5C7G5kHk9wP5oR9a4UxJR6cm');
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const WEBSOCKET_URL = process.env.WS_URL || 'ws://127.0.0.1:8900';
const connection = new Connection(RPC_URL, {
  wsEndpoint: WEBSOCKET_URL,
  commitment: 'processed',
  disableRetryOnRateLimit: true,
});
const baseToken = 'So11111111111111111111111111111111111111112'; // WSOL
const minLiquidityUSD = 6000;
const desiredProfitPercent = parseFloat(process.env.DESIRED_PROFIT_PERCENT || '3');
const HOLD_FOR_PROFIT = process.env.HOLD_FOR_PROFIT === 'true';
const TRAILING_STOP_LOSS_PERCENT = parseFloat(process.env.TRAILING_STOP_LOSS_PERCENT || '0');

const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY || ''));

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
  }
}

async function simulateBuySell(mintBuy: string, mintSell: string) {
  const cacheKey = `${mintBuy}_${mintSell}`;
  const cached = simulateCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.timestamp < CACHE_TTL_SIMULATE_JUPITER * 1000) {
    return cached.result;
  }
  const SOL_USD = liveSolUsd;
  const routes = await jupiter.computeRoutes({
    inputMint: new PublicKey(mintBuy),
    outputMint: new PublicKey(mintSell),
    amount: Math.floor((parseFloat(process.env.QUOTE_AMOUNT || '0.01') * 1_000_000_000)),
    slippage: 1,
    forceFetch: true,
  });

  const route = routes.routes?.[0] as RouteInfo;
  if (!route) return null;

  const output = route.outAmount / Math.pow(10, 9);
  const input = route.inAmount / Math.pow(10, 9);
  const profitPercent = ((output - input) / input) * 100;

  const profitUSD = (output - input) * SOL_USD;
  const result = { route, profitPercent, input, output, profitUSD };
  simulateCache.set(cacheKey, { timestamp: now, result });
  return result;
}

function estimateLiquidity(data: Buffer): number {
  try {
    const reserveA = Number(data.readBigUInt64LE(136));
    const reserveB = Number(data.readBigUInt64LE(144));
    const liquidity = (reserveA + reserveB) / Math.pow(10, 9);
    return liquidity;
  } catch {
    return 0;
  }
}

async function buyAndSell(route: RouteInfo, profit: number, profitUSD: number) {
  try {
    const before = Date.now();
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

    // Optional TPU send
    if (ENABLE_TPU_SEND && currentLeader) {
      const tpuAddress = `${currentLeader}`.replace('http://', '').replace('https://', '').split(':')[0];
      const socket = dgram.createSocket('udp4');
      socket.send(serialized, 0, serialized.length, 8001, tpuAddress, (err) => {
        // Log successful TPU send attempt
        console.log(`[${timestamp()}]  Sent to TPU: ${tpuAddress}:8001`);
        console.log(`[${timestamp()}]  Sent to TPU: ${tpuAddress}:8003`);
        if (err) console.warn(`[${timestamp()}] ⚠️ Failed to send to TPU:`, err);
        socket.close();
      });
    }

    const after = Date.now();
    const latencyMs = after - before;
    totalProfit += profit;
    successfulTrades++;

    const tokenPair = `${route.marketInfo.inputMint.toBase58()} -> ${route.marketInfo.outputMint.toBase58()}`;
    console.log(`[${timestamp()}] ✅ Buy+Sell executed in same block! Tx: ${txid}`);
    console.log(`[${timestamp()}]  Profit: $${profitUSD.toFixed(2)} | SOL: ${(profit).toFixed(6)}`);
    console.log(`[${timestamp()}] 燐 Win rate: ${(successfulTrades > 0 ? 100 : 0).toFixed(2)}% | Avg Profit: $${(totalProfit / successfulTrades || 0).toFixed(4)}`);
    console.log(`[${timestamp()}] ⏱️ Execution latency: ${latencyMs}ms |  Running profit total: $${totalProfit.toFixed(2)}`);

    await fs.appendFile('latency.txt', `[${timestamp()}] Tx: ${txid} | Latency: ${latencyMs}ms | Profit: $${profit.toFixed(6)} | ProfitUSD: $${profitUSD.toFixed(2)}
`).catch(() => {});
    await fs.appendFile('success.txt', `[${timestamp()}] SUCCESS: ${txid} | Profit: $${profitUSD.toFixed(2)} | Pair: ${tokenPair}
`).catch(() => {});
  } catch (err) {
    console.warn(`[${timestamp()}] ❌ Execution failed: ${err}`);
  }
} = await jupiter.exchange({ route, userPublicKey: wallet.publicKey });
    const txid = await execute();
    const after = Date.now();
    const latencyMs = after - before;

    totalProfit += profit;
    console.log(`[${timestamp()}] ✅ Buy+Sell executed in same block! Tx: ${txid}`);
    console.log(`[${timestamp()}] ⏱️ Execution latency: ${latencyMs}ms |  Running profit total: $${totalProfit.toFixed(2)}`);
  } catch (err) {
    console.warn(`[${timestamp()}] ❌ Execution failed: ${err}`);
  }
}

async function main() {
  console.log(`[${timestamp()}] ⏳ Initializing Jupiter and watching Raydium pools...`);
  jupiter = await Jupiter.load({ connection, cluster: 'mainnet-beta', userPublicKey: wallet.publicKey, routeCacheApiUrl: process.env.JUPITER_ROUTE_API || undefined,
});


  connection.onSlotChange(async (slotInfo: SlotInfo) => {
  latestSlot = slotInfo.slot;
  try {
    const leaders = await connection.getSlotLeaders(latestSlot, 1);
    currentLeader = leaders[0];
  } catch (e) {
    console.warn(`[${timestamp()}] ⚠️ Failed to get current leader:`, e);
    currentLeader = null;
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

      try {
        const [nonFreezableA, nonFreezableB] = await Promise.all([
          isNonFreezable(mintA),
          isNonFreezable(mintB),
        ]);

        if (!nonFreezableA || !nonFreezableB) {
          console.log(`[${timestamp()}] ⛔ Skipping pool ${accountId} due to freeze authority`);
          await logSkipped('freezable token', accountId, mintA, mintB, liquidity);
          return;
        }

        uniquePools.add(accountId);
        console.log(`[${timestamp()}]  New pool ${accountId} | MintA: ${mintA}, MintB: ${mintB} | Liquidity: $${liquidity}`);

        const [try1, try2] = await Promise.all([
          simulateBuySell(baseToken, mintA),
          simulateBuySell(baseToken, mintB),
        ]);

        const best = [try1, try2].filter(Boolean).sort((a, b) => b!.profitPercent - a!.profitPercent)[0];
        if (!best || best.profitPercent < desiredProfitPercent) {
          await logSkipped('not profitable', accountId, mintA, mintB, liquidity);
          return;
        }

        if (HOLD_FOR_PROFIT) {
          console.log(`[${timestamp()}] 流 HOLD mode active: not executing immediate sell. Waiting for target.`);

          const entry = best.input;
          const targetProfit = desiredProfitPercent;
          const trailingStop = TRAILING_STOP_LOSS_PERCENT;

          const heldData = JSON.stringify({
            timestamp: timestamp(),
            pool: accountId,
            mintA,
            mintB,
            entry,
            targetProfit,
            trailingStop,
            highest: best.output,
            baseToken
          });

          await fs.appendFile('held.txt', heldData + '
').catch(() => {});
          await logSkipped('hold mode active', accountId, mintA, mintB, liquidity);
          return;
        }
          await logSkipped('not profitable', accountId, mintA, mintB, liquidity);
          return;
        }

        console.log(`[${timestamp()}]  Profit opportunity: ${best.profitPercent.toFixed(2)}% — Slot: ${latestSlot} — Executing...`);
        await buyAndSell(best.route, best.output - best.input, best.profitUSD);
      } catch (err) {
        console.warn(`[${timestamp()}] ⚠️ Error processing pool ${accountId}: ${err}`);
        await logSkipped('error', accountId, mintA, mintB, liquidity);
      }
    },
    'confirmed'
  );
}

import zlib from 'zlib';
import { stat, createReadStream, createWriteStream, unlink } from 'fs';

async function rotateLogsIfLarge(filePath: string) {
  try {
    const stats = await fs.stat(filePath);
    if (stats.size >= 10 * 1024 * 1024) { // 10MB
      const gzPath = `${filePath}.${Date.now()}.gz`;
      const input = createReadStream(filePath);
      const output = createWriteStream(gzPath);
      const gzip = zlib.createGzip();
      input.pipe(gzip).pipe(output);
      output.on('finish', () => unlink(filePath, () => {}));
    }
  } catch {}
}

setInterval(() => {
  rotateLogsIfLarge('success.txt');
  rotateLogsIfLarge('latency.txt');
  rotateLogsIfLarge(getDailyLogFile());
}, 60_000); // check every minute

async function generateHtmlSummary() {
  const date = new Date().toISOString().slice(0, 10);
  const successLog = await fs.readFile('success.txt', 'utf-8').catch(() => '');
  const latencyLog = await fs.readFile('latency.txt', 'utf-8').catch(() => '');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Raydium Bot Summary - ${date}</title></head>
<body style="font-family:Arial,sans-serif;padding:20px;">
  <h1>Raydium Bot Summary - ${date}</h1>
  <h2>Summary Stats</h2>
  <p><strong>Total Profit:</strong> $${totalProfit.toFixed(2)}</p>
  <p><strong>Successful Trades:</strong> ${successfulTrades}</p>
  <p><strong>Average Profit:</strong> $${(totalProfit / successfulTrades || 0).toFixed(4)}</p>
  <hr>
  <h2>Recent Successes</h2>
  <pre>${successLog}</pre>
  <h2>Latency Records</h2>
  <pre>${latencyLog}</pre>
</body>
</html>`;

  await fs.writeFile(`summary-${date}.html`, html);
}

setInterval(() => {
  rotateLogsIfLarge('success.txt');
  rotateLogsIfLarge('latency.txt');
  rotateLogsIfLarge(getDailyLogFile());
  generateHtmlSummary().catch(() => {});
}, 60_000); // check every minute

main().catch(console.error);

// === Optional: Startup WSOL balance check and auto-wrap ===
(async () => {
  const AUTO_WRAP_SOL = process.env.AUTO_WRAP_SOL === 'true';
  const AUTO_WRAP_SOL_AMOUNT = parseFloat(process.env.AUTO_WRAP_SOL_AMOUNT || '0.01');
  const WARN_IF_NO_WSOL = process.env.WARN_IF_NO_WSOL !== 'false';

  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(baseToken),
    });

    const wsolAmount = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
    if (wsolAmount === 0) {
      if (AUTO_WRAP_SOL) {
        console.log(`[${timestamp()}]  No WSOL detected, auto-wrapping 0.01 SOL...`);
        const ix = SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: wallet.publicKey,
          lamports: AUTO_WRAP_SOL_AMOUNT * 1e9,
        });
        const tx = new Transaction().add(ix);
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        const sig = await connection.sendTransaction(tx, [wallet], { skipPreflight: true });
        console.log(`[${timestamp()}] ✅ Sent auto-wrap transaction: ${sig}`);
      } else if (WARN_IF_NO_WSOL) {
        console.warn(`[${timestamp()}] ⚠️ WARNING: No WSOL detected in your wallet. Please wrap SOL before trading.`);
      }
    }
  } catch (err) {
    console.warn(`[${timestamp()}] ⚠️ WSOL balance check failed:`, err);
  }
})();

// === Background watcher for trailing stop logic ===
setInterval(async () => {
  try {
    const data = await fs.readFile('held.txt', 'utf-8').catch(() => '');
    if (!data) return;
    const lines = data.trim().split('
');
    const remaining: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const { mintA, mintB, entry: entryPrice, highest, trailingStop } = entry;
        const [routeA, routeB] = await Promise.all([
          simulateBuySell(baseToken, mintA),
          simulateBuySell(baseToken, mintB)
        ]);
        const best = [routeA, routeB].filter(Boolean).sort((a, b) => b!.output - a!.output)[0];
        if (!best) {
          remaining.push(line);
          continue;
        }

        if (best.output > highest) entry.highest = best.output;

        const dropFromPeak = ((entry.highest - best.output) / entry.highest) * 100;
        if (dropFromPeak >= trailingStop) {
          console.log(`[${timestamp()}] ⛔ Trailing stop triggered for ${mintA}/${mintB}, drop: ${dropFromPeak.toFixed(2)}%`);
          await buyAndSell(best.route, best.output - best.input, best.profitUSD);
        } else {
          remaining.push(JSON.stringify(entry));
        }
      } catch {
        continue;
      }
    }

    await fs.writeFile('held.txt', remaining.join('
') + '
');
  } catch (err) {
    console.warn(`[${timestamp()}] ⚠️ Error in trailing stop watcher:`, err);
  }
}, 15_000);

