import 'dotenv/config';
const url = process.env.PIMLICO_BUNDLER_URL;
const key = process.env.PIMLICO_API_KEY;
const hash = process.argv[2];
async function main() {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getUserOperationReceipt', params: [hash] }),
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}
main();
