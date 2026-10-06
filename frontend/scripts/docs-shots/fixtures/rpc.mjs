// A fake JSON-RPC node for the public RPCs the app reads from (Arc for USDC
// balances and gas prices, CCTP source chains for the bridge dialog). Answers
// only the read methods a page makes while rendering; balances come from the
// API fixtures, so every number on screen is fictional.

/** RPC host → chain id. Hosts from frontend/src/config/networks.json and CctpFundModal. */
const CHAIN_BY_HOST = {
  'rpc.mainnet.arc.io': 5042,
  'rpc.testnet.arc.io': 5042002,
  'base-rpc.publicnode.com': 8453,
  'base-sepolia-rpc.publicnode.com': 84532,
  'ethereum-rpc.publicnode.com': 1,
  'ethereum-sepolia-rpc.publicnode.com': 11155111,
  'arb1.arbitrum.io': 42161,
  'arbitrum-rpc.publicnode.com': 42161,
  'polygon-bor-rpc.publicnode.com': 137,
  'optimism-rpc.publicnode.com': 10,
  '0g-rpc.publicnode.com': 16661,
  'evmrpc-testnet.0g.ai': 16602,
};

export function isRpcHost(host) {
  return Object.hasOwn(CHAIN_BY_HOST, host);
}

const BALANCE_OF = '0x70a08231';
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;

/** Answer a JSON-RPC body (single call or batch) sent to `host`. */
export function answerRpc(host, body, balances, now = Date.now()) {
  const chainId = CHAIN_BY_HOST[host];
  const gasPrice = chainId === 5042 || chainId === 5042002 ? 20_000_000_000n : 10_000_000n;
  const block = {
    number: '0x170ab32',
    hash: `0x${'1b'.repeat(32)}`,
    parentHash: `0x${'1a'.repeat(32)}`,
    timestamp: hex(Math.floor(now / 1000)),
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    gasLimit: '0x1c9c380',
    gasUsed: '0x5208',
    miner: `0x${'0'.repeat(40)}`,
    extraData: '0x',
    baseFeePerGas: hex(gasPrice),
    transactions: [],
    logsBloom: `0x${'0'.repeat(512)}`,
    sha3Uncles: `0x${'0'.repeat(64)}`,
    stateRoot: `0x${'0'.repeat(64)}`,
    receiptsRoot: `0x${'0'.repeat(64)}`,
    transactionsRoot: `0x${'0'.repeat(64)}`,
    uncles: [],
    size: '0x220',
  };

  const one = (call) => {
    const { id, method, params = [] } = call;
    let result = null;
    switch (method) {
      case 'eth_chainId': result = hex(chainId); break;
      case 'net_version': result = String(chainId); break;
      case 'eth_blockNumber': result = block.number; break;
      case 'eth_gasPrice': result = hex(gasPrice); break;
      case 'eth_maxPriorityFeePerGas': result = hex(gasPrice / 20n); break;
      case 'eth_getBlockByNumber': result = block; break;
      case 'eth_getCode': result = '0x'; break;
      case 'eth_getTransactionCount': result = '0x7'; break;
      case 'eth_estimateGas': result = hex(120_000); break;
      case 'eth_getBalance': {
        const who = String(params[0] || '').toLowerCase();
        result = hex(balances.native?.[chainId]?.[who] ?? 0n);
        break;
      }
      case 'eth_call': {
        const data = String(params[0]?.data || params[0]?.input || '');
        if (data.startsWith(BALANCE_OF)) {
          const who = `0x${data.slice(34, 74)}`.toLowerCase();
          result = word(balances.usdc?.[chainId]?.[who] ?? 0n);
        } else {
          result = word(0);
        }
        break;
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `docs-shots RPC: ${method} not available` } };
    }
    return { jsonrpc: '2.0', id, result };
  };

  return Array.isArray(body) ? body.map(one) : one(body);
}
