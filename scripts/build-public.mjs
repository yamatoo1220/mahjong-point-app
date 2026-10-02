// 公開版の配信ファイルを dist/ にまとめる（public-site/ と shared/ をコピーするだけ）
import { cpSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
cpSync("public-site", "dist", { recursive: true });
cpSync("shared", "dist/shared", { recursive: true });
console.log("built dist/ (public edition)");
