import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.14.0/dist/ethers.min.js";

export let provider, signer, account;

export async function connectWallet() {
  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  account = await signer.getAddress();
  return account;
}
