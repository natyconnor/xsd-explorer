/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true
  },
  allowedDevOrigins: ['*.replit.dev'],
};

export default nextConfig;
