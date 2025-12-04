const puppeteer = require('puppeteer');
const EventEmitter = require('events');
const ReplayerEffects = require('./ReplayerEffects');

/**
 * 상태 코드 (ReplayerStatusCode)
 */
const ReplayerStatusCode = {
    NO_URL_FOUND: 'NO_URL_FOUND',
    LAUNCH_FAILED: 'LAUNCH_FAILED',
    NO_PAGE_FOUND: 'NO_PAGE_FOUND',
    INVALID_DATA: 'INVALID_DATA',
    ALREADY_LAUNCHED: 'ALREADY_LAUNCHED',
    
    NOT_PLAYING: 'NOT_PLAYING',
    REPLAY_STOPPED: 'REPLAY_STOPPED',
    
    ACTION_FAILED: 'ACTION_FAILED',
    BUSY_TIMEOUT: 'BUSY_TIMEOUT',
    BROWSER_CLOSED: 'BROWSER_CLOSED',

    BROWSER_CONSOLE_ERROR: 'BROWSER_CONSOLE_ERROR',
    REQUEST_ERROR: 'REQUEST_ERROR'
};

class Replayer extends EventEmitter {
    constructor(option = {}) {
        super();

        if (!option.url) {
            throw new Error('URL은 필수입니다. option.url을 설정하세요.');
        }

        const defaultOptions = {
            url: '',
            type: 'web',
            busyIndicatorSelector: '.u4aUiBusyIndicator, .sapUiLocalBusyIndicator, .U4A_progress',
            busyTimeout: 60000 * 5,
            visualEffects: true,
            launchOptions: {
                headless: false,
                defaultViewport: null
            }
        };

        this.option = {
            ...defaultOptions,
            ...option,
            launchOptions: {
                ...defaultOptions.launchOptions,
                ...(option.launchOptions || {})
            }
        };

        if (!this.option.launchOptions.executablePath) {
            throw new Error('Chrome 실행 경로가 필요합니다. option.launchOptions.executablePath를 설정하세요.');
        }

        this.browser = null;
        this.page = null;
        this.isPlaying = false;
        this.consoleErrors = [];
        this._isClosing = false;

        // 🆕 시각 효과 모듈
        this.effects = null;
    }

    async launchPage() {
        if (this.browser) {
            return { 
                RETCD: 'E', 
                STCOD: ReplayerStatusCode.ALREADY_LAUNCHED, 
                MSGTX: '이미 브라우저가 실행 중입니다. 새 브라우저가 필요하면 먼저 close()를 호출하거나 새 인스턴스를 생성하세요.' 
            };
        }

        if (!this.option.url) {
            return { RETCD: 'E', STCOD: ReplayerStatusCode.NO_URL_FOUND, MSGTX: 'URL이 설정되지 않았습니다.' };
        }

        try {
            this.browser = await puppeteer.launch(this.option.launchOptions);
            this.page = await this.browser.newPage();

            // 시각 효과 인스턴스 생성
            this.effects = new ReplayerEffects(this.page);

            // visualEffects가 활성화된 경우에만 이벤트 등록
            if (this.option.visualEffects) {
                this.page.on('framenavigated', async (frame) => {
                    if (frame === this.page.mainFrame()) {
                        console.log('페이지 이동 감지 - 효과 재주입');
                        
                        if (this.effects) {
                            try {
                                await this.page.waitForSelector('body', { timeout: 5000 });
                                await this.effects.inject();
                                
                                if (this.isPlaying) {
                                    await this.effects.showReplayIndicator();
                                }
                            } catch (error) {
                                console.error('효과 재주입 실패:', error.message);
                            }
                        }
                    }
                });
            }

            this.browser.once('disconnected', () => {
                if (this._isClosing) return;
                
                console.log('브라우저가 강제 종료되었습니다.');
                this.isPlaying = false;
                this.browser = null;
                this.page = null;
                this.effects = null;
            });

            this.consoleErrors = [];

            this.page.on('console', async (msg) => {
                if (msg.type() === 'error') {
                    const args = msg.args();
                    for (const arg of args) {
                        const remoteObj = arg.remoteObject();
                        if (remoteObj.type === 'string') {
                            const error = {
                                type: ReplayerStatusCode.BROWSER_CONSOLE_ERROR,
                                message: remoteObj.value || '',
                                stack: '',
                                timestamp: Date.now()
                            };
                            this.consoleErrors.push(error);
                            this.emit('console-error', error);
                        } else if (remoteObj.type === 'object' && remoteObj.subtype === 'error') {
                            const description = remoteObj.description || '';
                            const message = description.split('\n')[0] || '';
                            const error = {
                                type: ReplayerStatusCode.BROWSER_CONSOLE_ERROR,
                                message: message,
                                stack: description,
                                timestamp: Date.now()
                            };
                            this.consoleErrors.push(error);
                            this.emit('console-error', error);
                        }
                    }
                }
            });

            this.page.on('pageerror', (error) => {
                const errorData = {
                    type: ReplayerStatusCode.BROWSER_CONSOLE_ERROR,
                    message: error.message,
                    stack: error.stack || '',
                    timestamp: Date.now()
                };
                this.consoleErrors.push(errorData);
                this.emit('console-error', errorData);
            });

            this.page.on('requestfailed', (request) => {
                const failure = request.failure();
                if (failure) {
                    const errorData = {
                        type: ReplayerStatusCode.REQUEST_ERROR,
                        message: failure.errorText || 'Request failed',
                        url: request.url(),
                        method: request.method(),
                        timestamp: Date.now()
                    };
                    this.consoleErrors.push(errorData);
                    this.emit('console-error', errorData); // 🆕 이벤트 발생
                }
            });

            await this.page.goto(this.option.url, { waitUntil: 'networkidle2' });

            // 🆕 시각 효과 주입
            if (this.option.visualEffects) {
                await this.effects.inject();
            }

            return { RETCD: 'S' };

        } catch (error) {
            return { RETCD: 'E', STCOD: ReplayerStatusCode.LAUNCH_FAILED, MSGTX: error.message };
        }
    }

    async reloadPage() {
        if (!this.page) {
            return { RETCD: 'E', STCOD: ReplayerStatusCode.NO_PAGE_FOUND, MSGTX: '먼저 페이지를 실행하세요.' };
        }

        try {
            await this.page.reload({ waitUntil: 'networkidle2' });

            if (this.option.visualEffects && this.effects) {
                await this.effects.inject();
            }

            return { RETCD: 'S' };

        } catch (error) {
            if (!this.browser) {
                return { RETCD: 'E', STCOD: ReplayerStatusCode.BROWSER_CLOSED, MSGTX: '브라우저가 닫혔습니다.' };
            }
            return { RETCD: 'E', STCOD: ReplayerStatusCode.REQUEST_ERROR, MSGTX: `새로고침 실패: ${error.message}` };
        }
    }

    async play(recordData) {
        if (!this.page) {
            return { RETCD: 'E', STCOD: ReplayerStatusCode.NO_PAGE_FOUND, MSGTX: '먼저 페이지를 실행하세요.' };
        }

        if (!recordData || !recordData.actions) {
            return { RETCD: 'E', STCOD: ReplayerStatusCode.INVALID_DATA, MSGTX: '유효한 recordData가 필요합니다.' };
        }

        // ✅ 수정됨: 시각 효과 주입 및 인디케이터 표시 로직 통합
        if (this.option.visualEffects && this.effects) {
            await this.effects.inject();              // 효과 스크립트/CSS 주입
            await this.effects.showReplayIndicator(); // 재생 중 표시 바 활성화
        }

        if (recordData.type) this.option.type = recordData.type;

        this.isPlaying = true;
        console.log(`Replay 시작... 타입: ${this.option.type}, 액션 수: ${recordData.actions.length}`);

        const actions = recordData.actions;
        let timeOffset = 0;

        for (let i = 0; i < actions.length; i++) {

            // 브라우저가 없는데 재생 중 = 사용자가 브라우저 닫음
            if ((!this.browser || !this.page) && this.isPlaying) {
                if (this.option.visualEffects && this.effects) {
                    try { await this.effects.hideReplayIndicator(); } catch (e) {}
                }
                this.isPlaying = false;
                return { 
                    RETCD: 'E', 
                    STCOD: ReplayerStatusCode.BROWSER_CLOSED, 
                    MSGTX: '사용자에 의해 브라우저가 종료되었습니다.',
                    RDATA: { consoleErrors: this.consoleErrors }
                };
            }

            // stop() 메서드 호출 (에러 감지 등)
            if (!this.isPlaying) {
                if (this.option.visualEffects && this.effects) {
                    await this.effects.hideReplayIndicator();
                }
                return { 
                    RETCD: 'E', 
                    STCOD: ReplayerStatusCode.REPLAY_STOPPED, 
                    MSGTX: 'Replay가 중지되었습니다.',
                    RDATA: { consoleErrors: this.consoleErrors }
                };
            }
            
            const action = actions[i];
            console.log(`[${i + 1}/${actions.length}] 액션 실행:`, action.type, action.selector);

            try {
                await this._waitForBusyIndicator();

                const executionStart = Date.now();
                await this._executeAction(action);
                const executionTime = Date.now() - executionStart;

                // 다음 액션까지 대기 시간 계산
                if (i < actions.length - 1) {
                    const nextAction = actions[i + 1];
                    let delay = nextAction.timestamp - action.timestamp;

                    timeOffset += executionTime;
                    const waitTime = Math.max(delay - timeOffset, 0);
                    timeOffset = Math.max(timeOffset - delay, 0);
                    
                    if (waitTime > 0) {
                        await this._delay(waitTime);
                    }
                } else {
                    // 마지막 액션 이후 녹화 종료 시간까지 대기
                    if (recordData.recordingEndTime) {
                        const lastActionTime = action.timestamp;
                        const recordingEndTime = new Date(recordData.recordingEndTime).getTime();
                        const finalDelay = recordingEndTime - lastActionTime;
                        
                        if (finalDelay > 0) {
                            console.log(`마지막 액션 후 대기: ${finalDelay}ms`);
                            await this._delay(finalDelay);
                        }
                    }
                }

            } catch (error) {
                this.isPlaying = false;
                
                // 에러 시 표시 숨김
                if (this.option.visualEffects && this.effects) {
                    try { await this.effects.hideReplayIndicator(); } catch (e) {}
                }

                if (!this.browser) {
                    return { 
                        RETCD: 'E', 
                        STCOD: ReplayerStatusCode.BROWSER_CLOSED, 
                        MSGTX: '브라우저가 닫혔습니다.',
                        RDATA: { consoleErrors: this.consoleErrors }
                    };
                }

                if (error.code === ReplayerStatusCode.BUSY_TIMEOUT) {
                    return { 
                        RETCD: 'E', 
                        STCOD: ReplayerStatusCode.BUSY_TIMEOUT, 
                        MSGTX: error.message,
                        RDATA: { consoleErrors: this.consoleErrors }
                    };
                }

                return { 
                    RETCD: 'E', 
                    STCOD: ReplayerStatusCode.ACTION_FAILED, 
                    MSGTX: `[Step ${i+1}] ${error.message}`,
                    RDATA: { consoleErrors: this.consoleErrors }
                };
            }
        }

        this.isPlaying = false;
        
        // 완료 시 표시 숨김
        if (this.option.visualEffects && this.effects) {
            await this.effects.hideReplayIndicator();
        }
        
        console.log('Replay 완료.');
        return { RETCD: 'S', RDATA: { consoleErrors: this.consoleErrors } };
    }

    stop() {
        if (!this.isPlaying) {
            return { RETCD: 'E', STCOD: ReplayerStatusCode.NOT_PLAYING, MSGTX: '진행 중인 Replay가 없습니다.' };
        }
        this.isPlaying = false;
        console.log('Replay 중지 요청됨.');
        return { RETCD: 'S' };
    }

    async close() {
        if (this._isClosing || !this.browser) return;
        
        this._isClosing = true;
        
        try {
            await this.browser.close();
        } catch (error) {
            console.error('브라우저 종료 중 오류:', error);
        }
        
        this.browser = null;
        this.page = null;
        this.isPlaying = false;
        this.consoleErrors = [];
        this.effects = null;
        
        this._isClosing = false;
    }

    // ===== Private Methods =====

    async _waitForBusyIndicator() {
        const selector = this.option.busyIndicatorSelector;
        const timeout = this.option.busyTimeout;
        const interval = 100;
        let elapsed = 0;

        while (elapsed < timeout) {
            if (!this.page || this.page.isClosed()) return;

            const isBusy = await this.page.evaluate((sel) => {
                const elements = document.querySelectorAll(sel);
                if (elements.length === 0) return false;

                return Array.from(elements).some(el => {
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden' && !el.hidden;
                });
            }, selector);

            if (!isBusy) return;

            await this._delay(interval);
            elapsed += interval;
        }

        const error = new Error(`busyIndicator 대기 시간 초과 (${timeout}ms). selector: ${selector}`);
        error.code = ReplayerStatusCode.BUSY_TIMEOUT;
        throw error;
    }

    async _executeAction(action) {
        if (!this.page || this.page.isClosed()) throw new Error('Page Closed');
        
        switch (action.type) {
            case 'click':          await this._executeClick(action); break;
            case 'input':          await this._executeInput(action); break;
            case 'change':         await this._executeChange(action); break;
            case 'keydown':        await this._executeKeydown(action); break;
            case 'scroll':         await this._executeScroll(action); break;
            case 'browser_resize': await this._executeBrowserResize(action); break;
            default: console.warn(`알 수 없는 액션 타입: ${action.type}`);
        }
    }

    async _executeClick(action) {
        if (this.option.visualEffects && this.effects) {
            await this.effects.showClick(action.selector, action.x, action.y);
        }
        
        // 🆕 체크박스/라디오 상태가 기록된 경우 명시적으로 설정
        if (action.checked !== undefined) {
            await this.page.waitForSelector(action.selector, { timeout: 5000 });
            await this.page.evaluate((sel, checked) => {
                const el = document.querySelector(sel);
                if (el && (el.type === 'checkbox' || el.type === 'radio')) {
                    el.checked = checked;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('click', { bubbles: true }));
                }
            }, action.selector, action.checked);
        } else if (action.x !== undefined && action.y !== undefined) {
            await this.page.mouse.click(action.x, action.y);
        } else {
            try {
                await this.page.waitForSelector(action.selector, { timeout: 5000 });
                await this.page.click(action.selector);
            } catch (error) {
                throw error;
            }
        }
    }

    async _executeInput(action) {
        await this.page.waitForSelector(action.selector, { timeout: 5000 });
        
        if (this.option.visualEffects && this.effects) {
            await this.effects.showInput(action.selector, action.value);
        }
        
        await this.page.evaluate((sel, val, selStart, selEnd) => {
            const el = document.querySelector(sel);
            if (el) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));                
                
                if (selStart !== undefined && selEnd !== undefined) {
                    const supportsSelection = ['text', 'search', 'url', 'tel', 'password'];
                    if (supportsSelection.includes(el.type)) {
                        el.setSelectionRange(selStart, selEnd);
                    }
                }
            }
        }, action.selector, action.value || '', action.selectionStart, action.selectionEnd);
    }

    async _executeChange(action) {
        await this.page.waitForSelector(action.selector, { timeout: 5000 });
        
        // 🆕 체크박스/라디오 처리
        if (action.checked !== undefined) {
            await this.page.evaluate((sel, checked) => {
                const el = document.querySelector(sel);
                if (el && (el.type === 'checkbox' || el.type === 'radio')) {
                    el.checked = checked;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, action.selector, action.checked);
        } else {
            // 기존 로직 (select 등)
            const element = await this.page.$(action.selector);
            const tagName = await this.page.evaluate(el => el.tagName.toLowerCase(), element);

            if (tagName === 'select') {
                await this.page.select(action.selector, action.value);
            } else {
                await this.page.evaluate((sel, val) => {
                    const el = document.querySelector(sel);
                    if (el) {
                        el.value = val;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, action.selector, action.value);
            }
        }
    }

    async _executeKeydown(action) {
        // 간결한 효과 호출
        if (this.option.visualEffects && this.effects) {
            await this.effects.showKeyPress(action.key);
        }
        
        await this.page.keyboard.press(action.key);
    }

    async _executeScroll(action) {
        const duration = action.duration || 300;
        const startX = action.startScrollX ?? action.scrollX;
        const startY = action.startScrollY ?? action.scrollY;
        const endX = action.scrollX;
        const endY = action.scrollY;

        if (action.selector === 'window') {
            await this.page.evaluate((startX, startY, endX, endY, duration) => {
                return new Promise((resolve) => {
                    const startTime = performance.now();
                    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
                    function step() {
                        const elapsed = performance.now() - startTime;
                        const progress = Math.min(elapsed / duration, 1);
                        const eased = easeOutCubic(progress);
                        window.scrollTo(startX + (endX - startX) * eased, startY + (endY - startY) * eased);
                        if (progress < 1) requestAnimationFrame(step); else resolve();
                    }
                    requestAnimationFrame(step);
                });
            }, startX, startY, endX, endY, duration);
        } else {
            await this.page.evaluate((sel, startX, startY, endX, endY, duration) => {
                const el = document.querySelector(sel);
                if (!el) return;
                return new Promise((resolve) => {
                    const startTime = performance.now();
                    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
                    function step() {
                        const elapsed = performance.now() - startTime;
                        const progress = Math.min(elapsed / duration, 1);
                        const eased = easeOutCubic(progress);
                        el.scrollLeft = startX + (endX - startX) * eased;
                        el.scrollTop = startY + (endY - startY) * eased;
                        if (progress < 1) requestAnimationFrame(step); else resolve();
                    }
                    requestAnimationFrame(step);
                });
            }, action.selector, startX, startY, endX, endY, duration);
        }
        
        // 간결한 효과 호출
        if (this.option.visualEffects && this.effects) {
            await this.effects.showScroll(action.selector);
        }
    }

    async _executeBrowserResize(action) {

        // 효과 추가
        if (this.option.visualEffects && this.effects) {
            await this.effects.showBrowserResize(
                action.fromWidth, 
                action.fromHeight, 
                action.toWidth, 
                action.toHeight
            );
        }

        const session = await this.page.target().createCDPSession();
        const { windowId } = await session.send('Browser.getWindowForTarget');
        
        await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: {
                width: action.toWidth,
                height: action.toHeight
            }
        });
        
        await session.detach();
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = { Replayer, ReplayerStatusCode };