export const description = "Current BTC price in USD from Coinbase public API."
export const parameters = {}
export async function run(args, { fetch, getJson }) {
const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
const data = await res.json();
return `$${Number(data.data.amount).toLocaleString("en-US", { maximumFractionDigits: 2 })} USD`;
}
