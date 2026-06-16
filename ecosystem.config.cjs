module.exports = {
  apps: [
    {
      name: "landa-refactor-backend",
      cwd: __dirname,
      script: "./dist/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production"
      },
      env_production: {
        NODE_ENV: "production"
      }
    }
  ]
}
