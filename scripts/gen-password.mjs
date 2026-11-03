/**
 * 生成后台（`/admin`）管理口令的 sha256。
 *
 * 用法：
 *   npm run gen-password -- 我想用的口令              # 只打印哈希
 *   npm run gen-password -- 我想用的口令 --write       # 顺便写进 .env.local
 *
 * 口令本身不落盘，写进 `.env.local` 的只有哈希。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'

const args = process.argv.slice(2)
const wantsWrite = args.includes('--write')
const raw = args.filter(a => a !== '--write').join(' ').trim()

if (!raw) {
  console.log('用法：npm run gen-password -- 你的口令 [--write]')
  process.exit(1)
}

const hash = createHash('sha256').update(raw).digest('hex')
console.log(`ADMIN_PASSWORD_HASH=${hash}`)

if (!wantsWrite) {
  console.log('\n把上面这一行填进 .env.local，重启 dev 生效。')
  process.exit(0)
}

const file = '.env.local'
const line = `ADMIN_PASSWORD_HASH=${hash}`
let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''

if (/^ADMIN_PASSWORD_HASH=.*$/m.test(text)) {
  text = text.replace(/^ADMIN_PASSWORD_HASH=.*$/m, line)
} else {
  const head = text.replace(/\s*$/, '')
  text = `${head}\n\n# ===== 管理员口令（后台访问保护）=====\n${line}\n`
}

fs.writeFileSync(file, text, 'utf8')
console.log(`\n已写入 ${file}，重启 dev 生效。`)
