import fs from 'node:fs'

const p = 'app/api/ai/route.ts'
let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const mark = '    // 2. 记忆的查询'
const i1 = s.indexOf(mark)
const i2 = s.indexOf(mark, i1 + 1)
if (i1 < 0 || i2 < 0) throw new Error('找不到重复的记忆意图调用')

s = s.slice(0, i1) + s.slice(i2)
fs.writeFileSync(p, s, 'utf8')
console.log('已去掉重复的一段')
