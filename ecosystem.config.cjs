module.exports = {
  apps: [
    {
      name: "landa-refactor-backend",
      cwd: "D:\\LANDA-PROD-NEW-REFACTOR\\landa-backend",
      script: "dist/index.js",
      interpreter: "node",
      node_args: "-r dotenv/config",
      env: {
        NODE_ENV: "production",
        DOTENV_CONFIG_PATH: ".env.production"
      }
    }
  ]
}