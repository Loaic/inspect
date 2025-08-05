const winston = require('winston');
const axios = require('axios');

class ProxyManager {
    constructor(config) {
        this.config = config;
        this.clashApiUrl = config.clash_api_url || 'http://127.0.0.1:9090';
        this.clashSecret = config.clash_secret || null;
        this.proxyPort = config.proxy_port || 7890;
        this.currentProxy = null;
        this.lastProxySwitch = 0;
        this.switchCooldown = config.proxy_switch_cooldown || 5000; // 5秒冷却时间
        
        // 设置axios请求头
        this.headers = {};
        if (this.clashSecret) {
            this.headers['Authorization'] = `Bearer ${this.clashSecret}`;
        }
        
        // 创建axios实例
        this.axiosInstance = axios.create({
            timeout: 10000,
            headers: this.headers
        });
    }

    /**
     * 获取可用的代理节点列表
     */
    async getAvailableProxies() {
        try {
            const response = await this.axiosInstance.get(`${this.clashApiUrl}/proxies`);
            const proxies = response.data.proxies;
            
            // 过滤出可用的代理节点（排除DIRECT、REJECT等特殊节点）
            const availableProxies = [];
            for (const [name, proxy] of Object.entries(proxies)) {
                if (proxy.type && 
                    !['Direct', 'Reject', 'Selector', 'URLTest', 'Fallback', 'LoadBalance'].includes(proxy.type) &&
                    proxy.alive !== false) {
                    availableProxies.push(name);
                }
            }
            
            winston.debug(`Found ${availableProxies.length} available proxy nodes`);
            return availableProxies;
        } catch (error) {
            winston.error('Failed to get available proxies:', error.message);
            return [];
        }
    }

    /**
     * 切换Clash使用的代理节点
     */
    async switchProxy(proxyName) {
        try {
            const now = Date.now();
            if (now - this.lastProxySwitch < this.switchCooldown) {
                winston.debug(`Proxy switch cooldown active, skipping switch to ${proxyName}`);
                return false;
            }

            const response = await this.axiosInstance.put(
                `${this.clashApiUrl}/proxies/PROXY`,
                { name: proxyName }
            );

            if (response.status === 204) {
                this.currentProxy = proxyName;
                this.lastProxySwitch = now;
                winston.info(`Successfully switched to proxy: ${proxyName}`);
                return true;
            }
            
            return false;
        } catch (error) {
            winston.warn(`Failed to switch proxy to ${proxyName}:`, error.message);
            return false;
        }
    }

    /**
     * 获取随机代理配置
     */
    async getRandomProxy() {
        const availableProxies = await this.getAvailableProxies();
        
        if (!availableProxies || availableProxies.length === 0) {
            winston.warn('No available proxy nodes');
            return null;
        }

        // 随机选择一个代理节点
        let selectedProxy = availableProxies[Math.floor(Math.random() * availableProxies.length)];
        
        // 如果当前代理就是选中的代理，且有其他选择，则重新选择
        if (selectedProxy === this.currentProxy && availableProxies.length > 1) {
            const otherProxies = availableProxies.filter(p => p !== this.currentProxy);
            selectedProxy = otherProxies[Math.floor(Math.random() * otherProxies.length)];
        }
        
        return await this.switchAndGetConfig(selectedProxy);
    }

    /**
     * 切换代理并返回配置
     */
    async switchAndGetConfig(proxyName) {
        const success = await this.switchProxy(proxyName);
        
        if (success) {
            const proxyConfig = {
                httpProxy: `http://127.0.0.1:${this.proxyPort}`,
                socksProxy: `socks5://127.0.0.1:${this.proxyPort + 1}` // 通常SOCKS端口是HTTP端口+1
            };
            
            return {
                config: proxyConfig,
                name: proxyName
            };
        }
        
        return null;
    }



    /**
     * 获取当前代理信息
     */
    getCurrentProxy() {
        return this.currentProxy;
    }

    /**
     * 测试代理连接
     */
    async testProxy(proxyName) {
        try {
            // 切换到测试代理
            const switched = await this.switchProxy(proxyName);
            if (!switched) {
                return false;
            }

            // 测试连接（可以ping一个简单的服务）
            const testResponse = await axios.get('http://httpbin.org/ip', {
                timeout: 5000,
                proxy: {
                    host: '127.0.0.1',
                    port: this.proxyPort
                }
            });
            
            if (testResponse.status === 200) {
                winston.debug(`Proxy ${proxyName} test successful`);
                return true;
            }
            
            return false;
        } catch (error) {
            winston.debug(`Proxy ${proxyName} test failed:`, error.message);
            return false;
        }
    }

    /**
     * 获取代理统计信息
     */
    getProxyStats() {
        const stats = {
            currentProxy: this.currentProxy
        };
        
        return stats;
    }
}

module.exports = ProxyManager;