import { hashPassword } from "../src/server/auth/password";

const password = process.argv[2];
if (!password) {
  console.error("Usage: npm run auth:hash -- '<password>'");
  process.exit(1);
}
console.log(hashPassword(password));
