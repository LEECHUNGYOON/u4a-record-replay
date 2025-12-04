/**
 * Replayer 시각 효과 모듈
 */
class ReplayerEffects {
    constructor(page) {
        this.page = page;
        this.isInjected = false;
    }

    /**
     * 시각 효과가 주입되어 있는지 확인
     */
    async isEffectsInjected() {
        if (!this.page || this.page.isClosed()) return false;
        
        try {
            return await this.page.evaluate(() => {
                return typeof window.u4aReplayEffects !== 'undefined';
            });
        } catch (error) {
            return false;
        }
    }

    /**
     * 시각 효과 주입
     */
    async inject() {
        if (!this.page || this.page.isClosed()) return;

        try {
            // CSS 주입
            await this.page.addStyleTag({
                content: `
                    /* 🆕 자동 재생 표시 - 최상단 중앙 */
                    .u4a-replay-indicator {
                        position: fixed;
                        top: 20px;
                        left: 50%;
                        transform: translateX(-50%);
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                        padding: 12px 24px;
                        border-radius: 25px;
                        font-family: system-ui, -apple-system, sans-serif;
                        font-size: 14px;
                        font-weight: 600;
                        z-index: 9999999;
                        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        animation: u4a-replay-pulse 2s ease-in-out infinite;
                        pointer-events: none; /* 🆕 클릭 이벤트 통과 */
                    }
                    
                    @keyframes u4a-replay-pulse {
                        0%, 100% {
                            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
                        }
                        50% {
                            box-shadow: 0 4px 25px rgba(102, 126, 234, 0.6);
                        }
                    }
                    
                    .u4a-replay-indicator-icon {
                        width: 16px;
                        height: 16px;
                        border: 2px solid white;
                        border-top-color: transparent;
                        border-radius: 50%;
                        animation: u4a-replay-spin 1s linear infinite;
                    }
                    
                    @keyframes u4a-replay-spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    
                    .u4a-replay-indicator-dot {
                        width: 8px;
                        height: 8px;
                        background: #ff4757;
                        border-radius: 50%;
                        animation: u4a-replay-blink 1.5s ease-in-out infinite;
                    }
                    
                    @keyframes u4a-replay-blink {
                        0%, 100% { opacity: 1; }
                        50% { opacity: 0.3; }
                    }
                    
                    /* 클릭 효과 */
                    .u4a-click-effect {
                        position: fixed;
                        width: 20px;
                        height: 20px;
                        border: 2px solid #007aff;
                        border-radius: 50%;
                        pointer-events: none;
                        z-index: 999999;
                        animation: u4a-click-fade 0.4s ease-out;
                        background: rgba(0, 122, 255, 0.2);
                    }
                    
                    @keyframes u4a-click-fade {
                        0% {
                            transform: translate(-50%, -50%) scale(0.5);
                            opacity: 1;
                        }
                        100% {
                            transform: translate(-50%, -50%) scale(2);
                            opacity: 0;
                        }
                    }
                    
                    /* 요소 하이라이트 */
                    .u4a-highlight {
                        outline: 2px solid #007aff !important;
                        outline-offset: 2px !important;
                    }
                    
                    /* 입력 중 표시 */
                    .u4a-typing {
                        background-color: rgba(0, 122, 255, 0.05) !important;
                    }
                    
                    /* 히스토리 */
                    .u4a-action-history {
                        position: fixed;
                        bottom: 20px;
                        right: 20px;
                        background: rgba(255, 255, 255, 0.95);
                        border: 1px solid #ddd;
                        border-radius: 8px;
                        font-family: system-ui, -apple-system, sans-serif;
                        font-size: 12px;
                        z-index: 999998;
                        width: 250px;
                        max-height: 200px;
                        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
                        display: flex;
                        flex-direction: column;
                        overflow: hidden;
                        pointer-events: none; /* 🆕 클릭 이벤트 통과 */
                    }
                    
                    /* 헤더 고정 */
                    .u4a-action-history-title {
                        position: sticky;
                        top: 0;
                        background: rgba(255, 255, 255, 0.98);
                        font-weight: 600;
                        font-size: 13px;
                        color: #333;
                        padding: 10px;
                        margin: 0;
                        border-bottom: 1px solid #eee;
                        z-index: 1;
                        flex-shrink: 0;
                    }
                    
                    /* 컨텐츠 영역 스크롤 */
                    .u4a-action-history-content {
                        flex: 1;
                        overflow-y: auto;
                        padding: 10px;
                    }
                    
                    .u4a-action-history-item {
                        padding: 6px;
                        margin: 3px 0;
                        border-radius: 4px;
                        font-size: 11px;
                        color: #666;
                        background: #f8f8f8;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    
                    .u4a-action-icon {
                        font-size: 14px;
                    }
                    
                    .u4a-action-time {
                        color: #999;
                        font-size: 10px;
                        margin-left: auto;
                    }
                `
            });

            // JavaScript 주입
            await this.page.evaluate(() => {
                // 🆕 자동 재생 표시 생성
                const createReplayIndicator = () => {
                    // 기존 표시 제거
                    const existing = document.getElementById('u4a-replay-indicator');
                    if (existing) existing.remove();
                    
                    const indicator = document.createElement('div');
                    indicator.className = 'u4a-replay-indicator';
                    indicator.id = 'u4a-replay-indicator';
                    indicator.innerHTML = `
                        <div class="u4a-replay-indicator-icon"></div>
                        <span>🤖 자동 재생 중...</span>
                        <div class="u4a-replay-indicator-dot"></div>
                    `;
                    indicator.style.display = 'none'; // 초기에는 숨김
                    document.body.appendChild(indicator);
                };
                
                createReplayIndicator();
                
                // 기존 히스토리 제거
                const existing = document.getElementById('u4a-action-history');
                if (existing) existing.remove();
                
                // 히스토리 컨테이너 구조
                const history = document.createElement('div');
                history.className = 'u4a-action-history';
                history.id = 'u4a-action-history';
                
                // 헤더 (고정)
                const header = document.createElement('div');
                header.className = 'u4a-action-history-title';
                header.textContent = 'Actions';
                
                // 컨텐츠 영역 (스크롤)
                const content = document.createElement('div');
                content.className = 'u4a-action-history-content';
                content.id = 'u4a-action-history-content';
                
                history.appendChild(header);
                history.appendChild(content);
                document.body.appendChild(history);
                
                const addToHistory = (icon, description) => {
                    const historyContent = document.getElementById('u4a-action-history-content');
                    if (!historyContent) return;
                    
                    const item = document.createElement('div');
                    item.className = 'u4a-action-history-item';
                    
                    const time = new Date().toLocaleTimeString('en-US', { 
                        hour12: false, 
                        hour: '2-digit', 
                        minute: '2-digit', 
                        second: '2-digit' 
                    });
                    
                    item.innerHTML = `
                        <span class="u4a-action-icon">${icon}</span>
                        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${description}</span>
                        <span class="u4a-action-time">${time}</span>
                    `;
                    
                    historyContent.appendChild(item);
                    
                    const items = historyContent.querySelectorAll('.u4a-action-history-item');
                    if (items.length > 8) {
                        items[0].remove();
                    }
                    
                    historyContent.scrollTop = historyContent.scrollHeight;
                };
                
                window.u4aReplayEffects = {

                    // 자동 재생 표시 제어
                    showReplayIndicator: () => {
                        const indicator = document.getElementById('u4a-replay-indicator');
                        if (indicator) {
                            indicator.style.display = 'flex';
                        }
                    },
                    
                    hideReplayIndicator: () => {
                        const indicator = document.getElementById('u4a-replay-indicator');
                        if (indicator) {
                            indicator.style.display = 'none';
                        }
                    },
                    
                    showClickEffect: (x, y, selector) => {
                        const effect = document.createElement('div');
                        effect.className = 'u4a-click-effect';
                        effect.style.left = x + 'px';
                        effect.style.top = y + 'px';
                        document.body.appendChild(effect);
                        setTimeout(() => effect.remove(), 400);
                        
                        const desc = selector ? selector.split('.')[0].substring(0, 20) : `${x},${y}`;
                        addToHistory('●', `Click: ${desc}`);
                    },
                    
                    highlightElement: (selector) => {
                        const el = document.querySelector(selector);
                        if (el) {
                            el.classList.add('u4a-highlight');
                            setTimeout(() => el.classList.remove('u4a-highlight'), 400);
                        }
                    },
                    
                    showTyping: (selector, value) => {
                        const el = document.querySelector(selector);
                        if (el) {
                            el.classList.add('u4a-typing');
                            setTimeout(() => el.classList.remove('u4a-typing'), 300);
                        }
                        
                        // 🆕 값도 함께 표시
                        let desc = 'Input';
                        if (value && value.length > 0) {
                            const shortValue = value.length > 10 ? value.substring(0, 10) + '...' : value;
                            desc = `Input: "${shortValue}"`;
                        }
                        
                        addToHistory('⌨', desc);
                    },
                    
                    showKeyPress: (key) => {
                        const keyDisplay = {
                            'Enter': 'Enter',
                            'Tab': 'Tab',
                            'Escape': 'Esc',
                            'ArrowUp': 'ArrowUp',
                            'ArrowDown': 'ArrowDown', 
                            'ArrowLeft': 'ArrowLeft',
                            'ArrowRight': 'ArrowRight',
                            'Backspace': 'Backspace',
                            'Delete': 'Delete',
                            'Space': 'Space'
                        };                       
                      
                        const keyName = keyDisplay[key] || key;
                        addToHistory('⌨', `Key: ${keyName}`);
                    },

                    showScroll: (selector) => {
                        const desc = selector === 'window' ? 'Window' : selector.substring(0, 15);
                        addToHistory('↕', `Scroll: ${desc}`);
                    },
          
                    showBrowserResize: (fromWidth, fromHeight, toWidth, toHeight) => {
                        const desc = `${toWidth}x${toHeight}`;
                        addToHistory('⬌', `Resize: ${desc}`);
                    }
                };
            });

            this.isInjected = true;
            console.log('✅ 시각 효과 주입 완료');

        } catch (error) {
            console.error('❌ 시각 효과 주입 실패:', error);
            this.isInjected = false;
        }
    }

    /**
     * 브라우저 리사이즈 효과 표시
     */
    async showBrowserResize(fromWidth, fromHeight, toWidth, toHeight) {
        await this.safeExecute(async () => {
            await this.page.evaluate((fw, fh, tw, th) => {
                if (window.u4aReplayEffects && window.u4aReplayEffects.showBrowserResize) {
                    window.u4aReplayEffects.showBrowserResize(fw, fh, tw, th);
                }
            }, fromWidth, fromHeight, toWidth, toHeight);
        });
    }

    /**
     * 자동 재생 표시 보이기
     */
    async showReplayIndicator() {
        await this.safeExecute(async () => {
            await this.page.evaluate(() => {
                if (window.u4aReplayEffects && window.u4aReplayEffects.showReplayIndicator) {
                    window.u4aReplayEffects.showReplayIndicator();
                }
            });
        });
    }

    /**
     * 자동 재생 표시 숨기기
     */
    async hideReplayIndicator() {
        await this.safeExecute(async () => {
            await this.page.evaluate(() => {
                if (window.u4aReplayEffects && window.u4aReplayEffects.hideReplayIndicator) {
                    window.u4aReplayEffects.hideReplayIndicator();
                }
            });
        });
    }    

    /**
     * 안전하게 효과 실행
     */
    async safeExecute(effectFn) {
        if (!this.page || this.page.isClosed()) return;

        try {
            // 주입 여부 확인
            if (!await this.isEffectsInjected()) {
                await this.inject();
            }

            await effectFn();
        } catch (error) {
            // 효과 실행 실패해도 계속 진행
        }
    }

    /**
     * 클릭 효과 표시
     */
    async showClick(selector, x, y) {
        await this.safeExecute(async () => {
            // 하이라이트
            await this.page.evaluate((sel) => {
                window.u4aReplayEffects.highlightElement(sel);
            }, selector);

            // 클릭 이펙트
            await this.page.evaluate((x, y, sel) => {
                window.u4aReplayEffects.showClickEffect(x, y, sel);
            }, x, y, selector);
        });
    }

    /**
     * 입력 효과 표시
     */
    async showInput(selector, value) {
        await this.safeExecute(async () => {
            await this.page.evaluate((sel, val) => {
                window.u4aReplayEffects.showTyping(sel, val);
            }, selector, value);
        });
    }

    /**
     * 키보드 효과 표시
     */
    async showKeyPress(key) {
        await this.safeExecute(async () => {
            await this.page.evaluate((k) => {
                window.u4aReplayEffects.showKeyPress(k);
            }, key);
        });
    }

    /**
     * 스크롤 효과 표시
     */
    async showScroll(selector) {
        await this.safeExecute(async () => {
            await this.page.evaluate((sel) => {
                if (window.u4aReplayEffects && window.u4aReplayEffects.showScroll) {
                    window.u4aReplayEffects.showScroll(sel);
                }
            }, selector);
        });
    }

    /**
     * 하이라이트만 표시
     */
    async showHighlight(selector) {
        await this.safeExecute(async () => {
            await this.page.evaluate((sel) => {
                window.u4aReplayEffects.highlightElement(sel);
            }, selector);
        });
    }
}

module.exports = ReplayerEffects;