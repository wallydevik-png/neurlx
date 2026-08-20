import { keypairFromSecret } from "./src/lib/memecoin/jupiter.server";
const m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
console.log("phrase:", (await keypairFromSecret(m)).publicKey.toBase58());
console.log("expected phantom: HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
