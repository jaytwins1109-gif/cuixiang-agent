// scripts/ts-alias-register.mjs
// 注册上面那个别名 loader：`node --import ./scripts/ts-alias-register.mjs xxx.ts`
import { register } from 'node:module';

register('./ts-alias-loader.mjs', import.meta.url);
