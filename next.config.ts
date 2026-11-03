import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 容器部署用：产出 .next/standalone（自带最小 node_modules 与 server.js）。
  // 本地 dev 不受影响；不加的话生产镜像得整包拷 node_modules，体积翻好几倍。
  output: 'standalone',
};

export default nextConfig;
