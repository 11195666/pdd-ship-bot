// PM2 ecosystem config — pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'pdd-server',
    script: './server.js',
    // cwd set by PM2 from the config file location
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '256M',
    env: { NODE_ENV: 'production', PORT: 3456 },
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
  }]
};
