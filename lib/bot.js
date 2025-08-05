const winston = require('winston'),
    SteamUser = require('steam-user'),
    GlobalOffensive = require('globaloffensive'),
    SteamTotp = require('steam-totp'),
    EventEmitter = require('events').EventEmitter;

class Bot extends EventEmitter {
    /**
     * Sets the ready status and sends a 'ready' or 'unready' event if it has changed
     * @param {*|boolean} val New ready status
     */
    set ready(val) {
        const prev = this.ready;
        this.ready_ = val;

        if (val !== prev) {
            this.emit(val ? 'ready' : 'unready');
        }
    }

    /**
     * Returns the current ready status
     * @return {*|boolean} Ready status
     */
    get ready() {
        return this.ready_ || false;
    }

    constructor(settings) {
        super();

        this.settings = settings;
        this.busy = false;

        // Retry configuration
        this.maxLoginRetries = this.settings.max_login_retries || 5;
        this.loginRetryDelay = this.settings.login_retry_delay || 5000; // 5 seconds base delay
        this.currentLoginRetries = 0;
        this.loginRetryTimeout = null;

        // GC reconnection configuration
        this.maxGCReconnectAttempts = this.settings.max_gc_reconnect_attempts || 10;
        this.gcReconnectDelay = this.settings.gc_reconnect_delay || 10000; // 10 seconds base delay
        this.currentGCReconnectAttempts = 0;
        this.gcReconnectTimeout = null;

        this.steamClient = new SteamUser(Object.assign({
            promptSteamGuardCode: false,
            enablePicsCache: true // Required to check if we own CSGO with ownsApp
        }, this.settings.steam_user));

        this.csgoClient = new GlobalOffensive(this.steamClient);

        // set up event handlers
        this.bindEventHandlers();

        // Variance to apply so that each bot relogins at different times
        const variance = parseInt(Math.random() * 4 * 60 * 1000);

        // As of 7/10/2020, GC inspect calls can timeout repeatedly for whatever reason
        setInterval(() => {
            if (this.csgoClient.haveGCSession) {
                this.relogin = true;
                this.steamClient.relog();
            }
        }, 30 * 60 * 1000 + variance);

        // Connection health monitoring
        this.lastGCActivity = Date.now();
        this.healthCheckInterval = setInterval(() => {
            this.performHealthCheck();
        }, 60000); // Check every minute
    }

    logIn(username, password, auth) {
        this.ready = false;

        // Save these parameters if we login later
        if (arguments.length === 3) {
            this.username = username;
            this.password = password;
            this.auth = auth;
        }

        winston.info(`Logging in ${this.username}`);

        // If there is a steam client, make sure it is disconnected
        if (this.steamClient) this.steamClient.logOff();

        this.loginData = {
            accountName: this.username,
            password: this.password,
            rememberPassword: true,
        };

        if (this.auth && this.auth !== '') {
            // Check if it is a shared_secret
            if (this.auth.length <= 5) this.loginData.authCode = this.auth;
            else {
                // Generate the code from the shared_secret
                winston.debug(`${this.username} Generating TOTP Code from shared_secret`);
                this.loginData.twoFactorCode = SteamTotp.getAuthCode(this.auth);
            }
        }

        winston.debug(`${this.username} About to connect`);
        this.steamClient.logOn(this.loginData);
    }

    bindEventHandlers() {
        this.steamClient.on('error', (err) => {
            winston.error(`Error logging in ${this.username}:`, err);

            let login_error_msgs = {
                61: 'Invalid Password',
                63: 'Account login denied due to 2nd factor authentication failure. ' +
                    'If using email auth, an email has been sent.',
                65: 'Account login denied due to auth code being invalid',
                66: 'Account login denied due to 2nd factor auth failure and no mail has been sent'
            };

            if (err.eresult && login_error_msgs[err.eresult] !== undefined) {
                winston.error(this.username + ': ' + login_error_msgs[err.eresult]);
            }

            // Check if this is a retryable error
            const retryableErrors = [
                'Proxy connection timed out',
                'LogonSessionReplaced',
                'ServiceUnavailable',
                'ConnectFailed',
                'Timeout'
            ];

            const isRetryableError = retryableErrors.some(errorType => 
                err.toString().includes(errorType) || 
                (err.eresult && [84, 85, 86, 87].includes(err.eresult)) // Network-related errors
            );

            if (isRetryableError && this.currentLoginRetries < this.maxLoginRetries) {
                this.scheduleLoginRetry();
            } else if (this.currentLoginRetries >= this.maxLoginRetries) {
                winston.error(`${this.username}: Max login retries (${this.maxLoginRetries}) exceeded. Giving up.`);
                this.emit('loginFailed', err);
            }
        });

        this.steamClient.on('disconnected', (eresult, msg) => {
            winston.warn(`${this.username} Logged off, reconnecting! (${eresult}, ${msg})`);
        });

        this.steamClient.on('loggedOn', (details, parental) => {
            winston.info(`${this.username} Log on OK`);
            
            // Reset login retry counter on successful login
            this.currentLoginRetries = 0;
            if (this.loginRetryTimeout) {
                clearTimeout(this.loginRetryTimeout);
                this.loginRetryTimeout = null;
            }

            // Fixes reconnecting to CS:GO GC since node-steam-user still assumes we're playing 730
            // and never sends the appLaunched event to node-globaloffensive
            this.steamClient.gamesPlayed([], true);

            if (this.relogin) {
                // Don't check ownership cache since the event isn't always emitted on relogin
                winston.info(`${this.username} Initiating GC Connection, Relogin`);
                this.steamClient.gamesPlayed([730], true);
                return;
            }

            // Ensure we own CSGO
            // We have to wait until app ownership is cached to safely check
            this.steamClient.once('ownershipCached', () => {
                if (!this.steamClient.ownsApp(730)) {
                    winston.info(`${this.username} doesn't own CS:GO, retrieving free license`);

                    // Request a license for CS:GO
                    this.steamClient.requestFreeLicense([730], (err, grantedPackages, grantedAppIDs) => {
                        winston.debug(`${this.username} Granted Packages`, grantedPackages);
                        winston.debug(`${this.username} Granted App IDs`, grantedAppIDs);

                        if (err) {
                            winston.error(`${this.username} Failed to obtain free CS:GO license`);
                        } else {
                            winston.info(`${this.username} Initiating GC Connection`);
                            this.steamClient.gamesPlayed([730], true);
                        }
                    });
                } else {
                    winston.info(`${this.username} Initiating GC Connection`);
                    this.steamClient.gamesPlayed([730], true);
                }
            });
        });

        this.csgoClient.on('inspectItemInfo', (itemData) => {
            if (this.resolve && this.currentRequest) {
                itemData = {iteminfo: itemData};

                // Ensure the received itemid is the same as what we want
                if (itemData.iteminfo.itemid !== this.currentRequest.a) return;

                // Update last GC activity time
                this.lastGCActivity = Date.now();

                // Clear any TTL timeout
                if (this.ttlTimeout) {
                    clearTimeout(this.ttlTimeout);
                    this.ttlTimeout = false;
                }

                // GC requires a delay between subsequent requests
                // Figure out how long to delay until this bot isn't busy anymore
                let offset = new Date().getTime() - this.currentRequest.time;
                let delay = this.settings.request_delay - offset;

                // If we're past the request delay, don't delay
                if (delay < 0) delay = 0;

                itemData.delay = delay;
                itemData.iteminfo.s = this.currentRequest.s;
                itemData.iteminfo.a = this.currentRequest.a;
                itemData.iteminfo.d = this.currentRequest.d;
                itemData.iteminfo.m = this.currentRequest.m;

                // If the paintseed is 0, the proto returns null, force 0
                itemData.iteminfo.paintseed = itemData.iteminfo.paintseed || 0;

                // paintwear -> floatvalue to match previous API version response
                itemData.iteminfo.floatvalue = itemData.iteminfo.paintwear;
                delete itemData.iteminfo.paintwear;

                // Backwards compatibility with previous node-globaloffensive versions
                for (const sticker of itemData.iteminfo.stickers) {
                    sticker.stickerId = sticker.sticker_id;
                    delete sticker.sticker_id;
                }

                this.resolve(itemData);
                this.resolve = false;
                this.currentRequest = false;

                setTimeout(() => {
                    // We're no longer busy (satisfied request delay)
                    this.busy = false;
                }, delay);
            }
        });

        this.csgoClient.on('connectedToGC', () => {
            winston.info(`${this.username} CSGO Client Ready!`);

            // Reset GC reconnect counter on successful connection
            this.currentGCReconnectAttempts = 0;
            if (this.gcReconnectTimeout) {
                clearTimeout(this.gcReconnectTimeout);
                this.gcReconnectTimeout = null;
            }

            // Update last activity time
            this.lastGCActivity = Date.now();
            this.ready = true;
        });

        this.csgoClient.on('disconnectedFromGC', (reason) => {
            winston.warn(`${this.username} CSGO unready (${reason}), trying to reconnect!`);
            this.ready = false;

            // Schedule GC reconnection with exponential backoff
            this.scheduleGCReconnect();
        });

        this.csgoClient.on('connectionStatus', (status) => {
            winston.debug(`${this.username} GC Connection Status Update ${status}`);
        });

        this.csgoClient.on('debug', (msg) => {
            winston.debug(msg);
        });
    }

    sendFloatRequest(link) {
        return new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.busy = true;

            const params = link.getParams();
            winston.debug(`${this.username} Fetching for ${params.a}`);

            this.currentRequest = {s: params.s, a: params.a, d: params.d, m: params.m, time: new Date().getTime()};

            if (!this.ready) {
                reject('This bot is not ready');
            }
            else {
                // The first param (owner) depends on the type of inspect link
                this.csgoClient.inspectItem(params.s !== '0' ? params.s : params.m, params.a, params.d);
            }

            // Set a timeout in case the GC takes too long to respond
            this.ttlTimeout = setTimeout(() => {
                // GC didn't respond in time, reset and reject
                this.busy = false;
                this.currentRequest = false;
                reject('ttl exceeded');
            }, this.settings.request_ttl);
        });
    }

    /**
     * Schedule a login retry with exponential backoff
     */
    scheduleLoginRetry() {
        this.currentLoginRetries++;
        const delay = this.loginRetryDelay * Math.pow(2, this.currentLoginRetries - 1);
        
        winston.warn(`${this.username} Scheduling login retry ${this.currentLoginRetries}/${this.maxLoginRetries} in ${delay}ms`);
        
        this.loginRetryTimeout = setTimeout(() => {
            winston.info(`${this.username} Attempting login retry ${this.currentLoginRetries}/${this.maxLoginRetries}`);
            this.logIn();
        }, delay);
    }

    /**
     * Schedule a GC reconnection with exponential backoff
     */
    scheduleGCReconnect() {
        if (this.currentGCReconnectAttempts >= this.maxGCReconnectAttempts) {
            winston.error(`${this.username} Max GC reconnect attempts (${this.maxGCReconnectAttempts}) exceeded. Stopping reconnection attempts.`);
            this.emit('gcReconnectFailed');
            return;
        }

        this.currentGCReconnectAttempts++;
        const delay = this.gcReconnectDelay * Math.pow(2, this.currentGCReconnectAttempts - 1);
        
        winston.warn(`${this.username} Scheduling GC reconnect ${this.currentGCReconnectAttempts}/${this.maxGCReconnectAttempts} in ${delay}ms`);
        
        this.gcReconnectTimeout = setTimeout(() => {
            winston.info(`${this.username} Attempting GC reconnect ${this.currentGCReconnectAttempts}/${this.maxGCReconnectAttempts}`);
            
            // Try to reconnect to GC by restarting the game
            if (this.steamClient.loggedOn) {
                this.steamClient.gamesPlayed([], true);
                setTimeout(() => {
                    this.steamClient.gamesPlayed([730], true);
                }, 1000);
            }
        }, delay);
    }

    /**
     * Perform health check on connections
     */
    performHealthCheck() {
        const now = Date.now();
        const gcInactiveTime = now - this.lastGCActivity;
        const maxInactiveTime = 10 * 60 * 1000; // 10 minutes

        // Check if Steam is logged in
        if (!this.steamClient.loggedOn) {
            winston.warn(`${this.username} Health check: Steam not logged in, attempting reconnection`);
            this.logIn();
            return;
        }

        // Check if GC has been inactive for too long
        if (this.ready && gcInactiveTime > maxInactiveTime) {
            winston.warn(`${this.username} Health check: GC inactive for ${Math.round(gcInactiveTime / 1000)}s, forcing reconnection`);
            this.ready = false;
            this.scheduleGCReconnect();
            return;
        }

        // Check if we should be ready but aren't
        if (this.steamClient.loggedOn && !this.ready && !this.gcReconnectTimeout) {
            winston.warn(`${this.username} Health check: Should be ready but isn't, attempting GC reconnection`);
            this.scheduleGCReconnect();
            return;
        }

        winston.debug(`${this.username} Health check: OK (Steam: ${this.steamClient.loggedOn ? 'connected' : 'disconnected'}, GC: ${this.ready ? 'ready' : 'not ready'})`);
    }

    /**
     * Clean up timers when bot is destroyed
     */
    destroy() {
        if (this.loginRetryTimeout) {
            clearTimeout(this.loginRetryTimeout);
            this.loginRetryTimeout = null;
        }
        
        if (this.gcReconnectTimeout) {
            clearTimeout(this.gcReconnectTimeout);
            this.gcReconnectTimeout = null;
        }

        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }

        if (this.steamClient) {
            this.steamClient.logOff();
        }
    }
}

module.exports = Bot;
