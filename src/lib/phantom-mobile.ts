import bs58 from "bs58";
import nacl from "tweetnacl";

const SECRET_KEY_STORAGE = "neurlx.phantom.connect.secret";

type PhantomConnectPayload = {
  public_key?: string;
  session?: string;
};

export function isMobileBrowser(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function createPhantomConnectUrl(): string {
  const keypair = nacl.box.keyPair();
  // Mobile Phantom may return through a newly-created browser tab, where
  // sessionStorage is empty. Keep only this short-lived handshake key in
  // origin-scoped localStorage and remove it immediately after decryption.
  localStorage.setItem(SECRET_KEY_STORAGE, bs58.encode(keypair.secretKey));

  const origin = window.location.origin;
  const redirectLink = `${origin}/memecoin?phantom_callback=1`;
  const params = new URLSearchParams({
    app_url: origin,
    dapp_encryption_public_key: bs58.encode(keypair.publicKey),
    redirect_link: redirectLink,
    cluster: "mainnet-beta",
  });
  return `https://phantom.app/ul/v1/connect?${params.toString()}`;
}

export function readPhantomConnectResult(search: string): PhantomConnectPayload | null {
  const params = new URLSearchParams(search);
  if (params.get("phantom_callback") !== "1") return null;
  const errorMessage = params.get("errorMessage");
  if (errorMessage) throw new Error(errorMessage);

  const phantomPublicKey = params.get("phantom_encryption_public_key");
  const nonce = params.get("nonce");
  const encryptedData = params.get("data");
  const secretKey = localStorage.getItem(SECRET_KEY_STORAGE);
  if (!phantomPublicKey || !nonce || !encryptedData || !secretKey) {
    throw new Error("Phantom returned without a complete connection response. Please try again.");
  }

  const sharedSecret = nacl.box.before(bs58.decode(phantomPublicKey), bs58.decode(secretKey));
  const decrypted = nacl.box.open.after(
    bs58.decode(encryptedData),
    bs58.decode(nonce),
    sharedSecret,
  );
  if (!decrypted) throw new Error("Phantom connection response could not be verified.");

  localStorage.removeItem(SECRET_KEY_STORAGE);
  return JSON.parse(new TextDecoder().decode(decrypted)) as PhantomConnectPayload;
}