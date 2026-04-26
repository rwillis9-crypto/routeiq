import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// IMPORTANT: Change 'routeiq' below to your GitHub repository name.
// Example: if your repo is github.com/username/sales-planner, set base to '/sales-planner/'
export default defineConfig({
  plugins: [react()],
  base: '/routeiq/',
})
