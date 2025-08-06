const Bot = require('./bot'),
    utils = require('./utils'),
    EventEmitter = require('events').EventEmitter,
    errors = require('../errors'),
    winston = require('winston');

class BotController extends EventEmitter {
    constructor() {
        super();

        this.readyEvent = false;
        this.bots = [];
        this.initializationComplete = false;
        this.initializationTimeout = null;
    }

    async addBot(loginData, settings) {
        // 为每个Bot分配索引，用于V2Ray代理分配
        settings.botIndex = this.bots.length;
        
        let bot = new Bot(settings);
        
        // 添加登录失败事件监听
        bot.on('login_failed', () => {
            winston.error(`Bot ${loginData.user} login failed permanently`);
        });

        bot.on('ready', () => {
            winston.info(`Bot ${loginData.user} is now ready`);
            if (!this.readyEvent && this.hasBotOnline()) {
                this.readyEvent = true;
                this.emit('ready');
            }
            
            // 检查是否所有机器人都初始化完成
            this.checkInitializationComplete();
        });

        bot.on('unready', () => {
            winston.warn(`Bot ${loginData.user} is now unready`);
            if (this.readyEvent && this.hasBotOnline() === false) {
                this.readyEvent = false;
                this.emit('unready');
            }
        });

        this.bots.push(bot);
        
        try {
            await bot.logIn(loginData.user, loginData.pass, loginData.auth);
            winston.info(`Bot ${loginData.user} login initiated`);
        } catch (error) {
            winston.error(`Failed to initiate login for bot ${loginData.user}:`, error.message);
        }
    }

    // 等待所有机器人初始化完成
    async waitForInitialization(timeout = 300000) { // 5分钟超时
        return new Promise((resolve, reject) => {
            if (this.initializationComplete) {
                resolve();
                return;
            }

            this.initializationTimeout = setTimeout(() => {
                winston.warn('Bot initialization timeout reached');
                resolve(); // 超时后继续，而不是失败
            }, timeout);

            this.once('initialization_complete', () => {
                if (this.initializationTimeout) {
                    clearTimeout(this.initializationTimeout);
                    this.initializationTimeout = null;
                }
                resolve();
            });
        });
    }

    // 检查初始化是否完成
    checkInitializationComplete() {
        if (this.initializationComplete) return;

        const readyBots = this.getReadyAmount();
        const totalBots = this.bots.length;
        
        winston.info(`Bot status: ${readyBots}/${totalBots} ready`);
        
        // 如果至少有一个机器人就绪，或者所有机器人都尝试过登录，则认为初始化完成
        if (readyBots > 0 || this.allBotsAttemptedLogin()) {
            this.initializationComplete = true;
            this.emit('initialization_complete');
            winston.info('Bot initialization completed');
        }
    }

    // 检查是否所有机器人都尝试过登录
    allBotsAttemptedLogin() {
        return this.bots.every(bot => bot.username); // 如果有username说明尝试过登录
    }

    getFreeBot() {
        // Shuffle array to evenly distribute requests
        for (let bot of utils.shuffleArray(this.bots)) {
            if (!bot.busy && bot.ready) return bot;
        }

        return false;
    }

    hasBotOnline() {
        for (let bot of this.bots) {
            if (bot.ready) return true;
        }

        return false;
    }

    getReadyAmount() {
        let amount = 0;
        for (const bot of this.bots) {
            if (bot.ready) {
                amount++;
            }
        }
        return amount;
    }

    // 获取机器人状态信息
    getBotStatus() {
        return this.bots.map(bot => ({
            username: bot.username,
            ready: bot.ready,
            busy: bot.busy,
            loginRetries: bot.loginRetries || 0,
            gcReconnectAttempts: bot.gcReconnectAttempts || 0
        }));
    }

    lookupFloat(data) {
        let freeBot = this.getFreeBot();

        if (freeBot) return freeBot.sendFloatRequest(data);
        else return Promise.reject(errors.NoBotsAvailable);
    }

    // 清理所有机器人
    destroy() {
        for (const bot of this.bots) {
            bot.destroy();
        }
        this.bots = [];
        
        if (this.initializationTimeout) {
            clearTimeout(this.initializationTimeout);
            this.initializationTimeout = null;
        }
    }
}

module.exports = BotController;
