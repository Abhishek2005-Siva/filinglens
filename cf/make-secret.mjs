// Prints the value to store as the SITE_PASSWORD_HMAC secret:  node cf/make-secret.mjs  (then type the site password; nothing is saved to disk)
import { createHmac } from 'node:crypto'
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin, output: process.stderr })
rl.question('Site password: ', (p) => {
  rl.close()
  console.log(createHmac('sha256', 'filinglens-login-v1').update(p).digest('hex'))
})
