import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'e2e',workers:1,use:{baseURL:'http://127.0.0.1:5173',headless:true},webServer:[{command:'npm run mock',port:8788,reuseExistingServer:false},{command:'npm run dev -- --port 5173',port:5173,reuseExistingServer:false}]});
