const { createConfig } = require('./config');
const config = createConfig();
for (const key of ['uploadsRoot', 'incomingDir', 'originalsDir', 'originalsRoots']) console.log(key, config[key]);
