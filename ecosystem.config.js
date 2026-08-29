module.exports = {
    apps: [
        {
            name: 'agente-pessoal',
            script: 'index.js',
            cwd: __dirname,
            watch: false,
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
            env: {
                NODE_ENV: 'production'
            }
        },
        {
            name: 'agente-recepcao',
            script: 'recep.js',
            cwd: __dirname,
            watch: false,
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
            env: {
                NODE_ENV: 'production'
            }
        }
    ]
};
