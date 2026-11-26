import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['worker/src/**/*.test.ts'],environment:'node',exclude:['web/**','tools/**','security/**','qa/**','node_modules/**']}});
