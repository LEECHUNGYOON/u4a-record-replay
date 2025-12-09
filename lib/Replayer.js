const puppeteer = require('puppeteer');
const EventEmitter = require('events');
const ReplayerEffects = require('./ReplayerEffects');

/**
 * 상태 코드 (ReplayerStatusCode)
 */
const ReplayerStatusCode = {
    BROWSER_CLOSED: 'BROWSER_CLOSED',
    REPLAY_STOPPED: 'REPLAY_STOPPED',
    
    LAUNCH_FAILED: 'LAUNCH_FAILED',
    ACTION_FAILED: 'ACTION_FAILED',
    BUSY_TIMEOUT: 'BUSY_TIMEOUT',
    NO_PAGE_FOUND: 'NO_PAGE_FOUND',
    NO_URL_FOUND: 'NO_URL_FOUND',
    INVALID_DATA: 'INVALID_DATA',
    ALREADY_LAUNCHED: 'ALREADY_LAUNCHED',
    NOT_PLAYING: 'NOT_PLAYING',
    REQUEST_ERROR: 'REQUEST_ERROR',

    BROWSER_CONSOLE_ERROR: 'BROWSER_CONSOLE_ERROR'
};

/**
 * 재생기 상태 (ReplayerState)
 */
const ReplayerState = {
    IDLE: 'IDLE',           
    LAUNCHING: 'LAUNCHING', 
    LAUNCHED: 'LAUNCHED',   
    PLAYING: 'PLAYING',     
    CLOSING: 'CLOSING'      
};

class Replayer extends EventEmitter {
    constructor(option = {}) {
        super();

        if (!option.url) {
            throw new Error('[Replayer] URL은 필수입니다. option.url을 설정하세요.');
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
            throw new Error('[Replayer] Chrome 실행 경로가 필요합니다. option.launchOptions.executablePath를 설정하세요.');
        }

        this._status = ReplayerState.IDLE;

        this.browser = null;
        this.page = null;
        this.consoleErrors = [];
        this.effects = null;
    }

    // ===== 상태 접근자 =====
    get status() { return this._status; }
    set status(val) { this._status = val; }

    // ===== 주요 메서드 =====

    /**
     * 브라우저 실행 (Launch)
     */
    async launchPage() {
        if (this.status !== ReplayerState.IDLE) {
            return { RETCD: 'E', STCOD: ReplayerStatusCode.ALREADY_LAUNCHED, MSGTX: '이미 실행 중입니다.' };
        }

        this.status = ReplayerState.LAUNCHING;

        try {
            this.browser = await puppeteer.launch(this.option.launchOptions);

            if (this.status === ReplayerState.CLOSING) {
                await this.close(); 
                return { RETCD: 'E', STCOD: ReplayerStatusCode.BROWSER_CLOSED, MSGTX: '실행 중 중단됨' };
            }

            const aPages = await this.browser.pages();
            var page = aPages[0];
            if(!page){
                page = await this.browser.newPage();
            }

            this.page = page;
            this.effects = new ReplayerEffects(this.page);

            this._registerBrowserEvents();

            await this.page.goto(this.option.url, { waitUntil: 'networkidle0' });

            if (this.status === ReplayerState.CLOSING) {
                await this.close();
                return { RETCD: 'E', STCOD: ReplayerStatusCode.BROWSER_CLOSED, MSGTX: '사용자 중단' };
            }

            if (this.option.visualEffects) {
                await this.effects.inject();
            }

            this.status = ReplayerState.LAUNCHED;
            return { RETCD: 'S' };

        } catch (error) {
            await this.close(); 

            if (this.status === ReplayerState.CLOSING) {
                return { RETCD: 'E', STCOD: ReplayerStatusCode.BROWSER_CLOSED, MSGTX: '사용자 중단' };
            }
            return { RETCD: 'E', STCOD: ReplayerStatusCode.LAUNCH_FAILED, MSGTX: error.message };
        }
    }

    /**
     * 페이지 새로고침
     */
    async reloadPage() {
        if (!this.page) return { RETCD: 'E', STCOD: ReplayerStatusCode.NO_PAGE_FOUND, MSGTX: '페이지 없음' };

        try {
            await this.page.reload({ waitUntil: 'networkidle2' });
            if (this.option.visualEffects && this.effects) await this.effects.inject();
            return { RETCD: 'S' };
        } catch (error) {
            if (this.status === ReplayerState.CLOSING) return { RETCD: 'E', STCOD: ReplayerStatusCode.BROWSER_CLOSED, MSGTX: '취소됨' };
            return { RETCD: 'E', STCOD: ReplayerStatusCode.REQUEST_ERROR, MSGTX: error.message };
        }
    }

   /**
     * 재생 시작 (Play)
     * - 전체 recordData를 받아 메타데이터(recordingEndTime 등)를 활용한다.
     * - 마지막 액션 후 녹화 종료 시점까지의 대기 시간을 구현한다.
     * * @param {Object} recordData - 녹화된 JSON 데이터 전체 ({ url, actions, recordingEndTime, ... })
     * @returns {Promise<Object>} { RETCD, STCOD, MSGTX, RDATA }
     */
    async play(recordData) { 

        // 1. 데이터 검증 (전체 객체 기준)
        if (!recordData || !Array.isArray(recordData.actions)) {
            return { 
                RETCD: 'E', 
                STCOD: ReplayerStatusCode.INVALID_DATA, 
                MSGTX: '유효한 녹화 데이터(recordData)가 아닙니다.' 
            };
        }

        // 2. 상태 검증
        if (this.status !== ReplayerState.LAUNCHED) {
            return { 
                RETCD: 'E', 
                STCOD: ReplayerStatusCode.NO_PAGE_FOUND, 
                MSGTX: '브라우저가 준비되지 않았습니다. (Launch First)' 
            };
        }

        const actions = recordData.actions;
        if (actions.length === 0) {
            return { RETCD: 'E', STCOD: ReplayerStatusCode.INVALID_DATA, MSGTX: '실행할 액션이 없습니다.' };
        }

        // 3. 시작 설정
        this.status = ReplayerState.PLAYING;
        console.log(`[Replayer] Started. Actions: ${actions.length}`);

        // 시각 효과 인디케이터 표시
        if (this.option.visualEffects && this.effects) {
            try {
                await this.effects.inject(); // 안전장치
                await this.effects.showReplayIndicator();
            } catch(e) { console.warn('Effect inject failed', e); }
        }

        // Type 설정 (옵션)
        if (recordData.type) this.option.type = recordData.type;

        // 실행 시간 보정용 오프셋
        let timeOffset = 0;

        try {
            for (let i = 0; i < actions.length; i++) {
                
                // [Loop 검문] Stop/Close 체크
                if (this.status !== ReplayerState.PLAYING) {
                    await this._hideReplayIndicatorSafe();
                    
                    if (this.status === ReplayerState.CLOSING) {
                        return { RETCD: 'E', STCOD: ReplayerStatusCode.BROWSER_CLOSED, MSGTX: '브라우저 닫힘', RDATA: { consoleErrors: this.consoleErrors } };
                    }
                    return { RETCD: 'E', STCOD: ReplayerStatusCode.REPLAY_STOPPED, MSGTX: '재생 중지됨', RDATA: { consoleErrors: this.consoleErrors } };
                }

                const action = actions[i];
                console.log(`[Replayer] Step ${i+1}: ${action.type}`);

                // Busy Indicator 대기
                await this._waitForBusyIndicator();

                // -------------------------------------------------
                // [액션 실행 및 시간 측정]
                // -------------------------------------------------
                const executionStart = Date.now();
                
                await this._executeAction(action);
                
                const executionTime = Date.now() - executionStart;
                // -------------------------------------------------

                // [타이밍 조절 로직]
                
                // Case 1: 다음 액션이 있는 경우 (Inter-Action Delay)
                if (i < actions.length - 1) {
                    const nextAction = actions[i + 1];
                    
                    if (action.timestamp && nextAction.timestamp) {
                        let delay = nextAction.timestamp - action.timestamp;

                        // 실행 시간 누적하여 대기 시간에서 차감
                        timeOffset += executionTime;
                        const waitTime = Math.max(delay - timeOffset, 0);
                        
                        // 남은 오프셋 정산 (delay보다 timeOffset이 크면 다음으로 이월)
                        timeOffset = Math.max(timeOffset - delay, 0);

                        if (waitTime > 0) await this._delay(waitTime);
                    }
                } 
                // Case 2: 마지막 액션인 경우 (Final Delay - 녹화 종료 시간까지 대기)
                else {

                    if (recordData.recordingEndTime && action.timestamp) {
                        const lastActionTime = action.timestamp;
                        // 날짜 객체일 수 있으므로 getTime()으로 변환하여 안전하게 계산
                        const recordingEndTime = new Date(recordData.recordingEndTime).getTime();
                        
                        // 마지막 액션 시간과 녹화 종료 시간의 차이
                        const finalDelay = recordingEndTime - lastActionTime;
                        
                        if (finalDelay > 0) {
                            // 실행 오프셋 반영
                            timeOffset += executionTime;
                            const waitTime = Math.max(finalDelay - timeOffset, 0);
                            
                            console.log(`[Replayer] Final Delay: ${waitTime}ms (Original: ${finalDelay}ms)`);
                            
                            if (waitTime > 0) await this._delay(waitTime);
                        }
                    }
                }
            }

            // 재생 완료
            await this._hideReplayIndicatorSafe();
            this.emit('finish');
            
            // 상태 복귀 -> LAUNCHED (다음 재생 대기)
            this.status = ReplayerState.LAUNCHED;
            
            return { RETCD: 'S', RDATA: { consoleErrors: this.consoleErrors } };

        } catch (error) {
            // 에러 처리 (기존 동일)
            this.status = ReplayerState.LAUNCHED; 
            await this._hideReplayIndicatorSafe();

            if (error.code === ReplayerStatusCode.BUSY_TIMEOUT) {
                return { RETCD: 'E', STCOD: ReplayerStatusCode.BUSY_TIMEOUT, MSGTX: error.message, RDATA: { consoleErrors: this.consoleErrors } };
            }
            if (error.message.includes('Target closed') || !this.page) {
                this.status = ReplayerState.IDLE; 
                return { RETCD: 'E', STCOD: ReplayerStatusCode.BROWSER_CLOSED, MSGTX: '브라우저 연결 끊김', RDATA: { consoleErrors: this.consoleErrors } };
            }
            return { RETCD: 'E', STCOD: ReplayerStatusCode.ACTION_FAILED, MSGTX: error.message, RDATA: { consoleErrors: this.consoleErrors } };
        }
    }

    /**
     * 현재 페이지 화면 캡처
     * - 표준 리턴 구조 (RETCD, STCOD, RDATA) 준수
     * - 기본값: Binary(Buffer) 반환 (RDATA에 담김)
     * * @param {Object} [options={}] - 캡처 옵션
     * @returns {Promise<Object>} { RETCD, STCOD, MSGTX, RDATA }
     */
    async captureScreen(options = {}) {
        
        // 1. 상태 검문 (실패 시 표준 에러 리턴)
        if (!this.page || this.page.isClosed()) {
            return { 
                RETCD: 'E', 
                STCOD: ReplayerStatusCode.NO_PAGE_FOUND, 
                MSGTX: '[Replayer] 캡처할 페이지가 없거나 닫혀있습니다.' 
            };
        }

        try {
            // 2. 옵션 기본값 병합 (Binary가 기본!)
            const captureOpts = {
                type: 'png',
                fullPage: false,
                encoding: 'binary', // <--- Default: Buffer
                ...options
            };

            // 3. 촬영 (Puppeteer)
            // path가 있으면 파일로 저장되고 result는 Buffer(또는 void)가 됨
            const result = await this.page.screenshot(captureOpts);

            // 4. 결과 데이터 정리
            // 경로(path)를 지정했다면 RDATA는 경로, 아니면 이미지 데이터(Buffer/Base64)
            const rData = captureOpts.path ? captureOpts.path : result;

            // 5. 성공 보고 (표준 규격)
            return { 
                RETCD: 'S', 
                RDATA: rData 
            };

        } catch (error) {
            console.error('[Replayer] Screenshot failed:', error);
            
            // 6. 실패 보고 (표준 규격)
            return { 
                RETCD: 'E', 
                STCOD: ReplayerStatusCode.ACTION_FAILED, 
                MSGTX: `스크린샷 촬영 실패: ${error.message}` 
            };
        }
    }

    /**
     * 재생 중지 (Stop)
     */
    stop() {
        if (this.status !== ReplayerState.PLAYING) {
            return { RETCD: 'E', STCOD: ReplayerStatusCode.NOT_PLAYING, MSGTX: '재생 중이 아닙니다.' };
        }
        this.status = ReplayerState.LAUNCHED;
        console.log('[Replayer] Stop Requested');
        return { RETCD: 'S' };
    }

    /**
     * 브라우저 종료 (Close)
     */
    async close() {
        if (this.status === ReplayerState.IDLE || this.status === ReplayerState.CLOSING) return;

        this.status = ReplayerState.CLOSING;

        if (this.browser && this.browser.isConnected()) {
            try {
                const pages = await this.browser.pages();
                await Promise.all(pages.map(page => page.close().catch(() => {})));
                await this.browser.close();
            } catch (e) {
                console.warn('Browser close warning:', e.message);
            }
        }

        this._resetState();
    }

    // ===== Private Helpers =====

    _resetState() {
        this.browser = null;
        this.page = null;
        this.effects = null;
        this.consoleErrors = [];
        this.status = ReplayerState.IDLE;
    }

    _registerBrowserEvents() {
        if (!this.browser || !this.page) return;

        if (this.option.visualEffects) {
            this.page.on('framenavigated', async (frame) => {
                if (frame === this.page.mainFrame()) {
                    if (this.effects) {
                        try {
                            await this.page.waitForSelector('body', { timeout: 5000 });
                            await this.effects.inject();
                            if (this.status === ReplayerState.PLAYING) {
                                await this.effects.showReplayIndicator();
                            }
                        } catch (error) {
                            console.error('효과 재주입 실패:', error.message);
                        }
                    }
                }
            });
        }

        // [수정] disconnected 시 error 이벤트 호출 제거! 상태만 리셋합니다.
        this.browser.once('disconnected', () => {
            if (this.status !== ReplayerState.CLOSING) {
                console.log('[Replayer] Browser Disconnected unexpectedly');
                this._resetState();
            }
        });

        this.page.on('console', msg => {
            if (msg.type() === 'error') {
                const args = msg.args();
                args.forEach(arg => {
                    try {
                        const remoteObj = arg.remoteObject();
                        let message = '';
                        let stack = '';

                        if (remoteObj.type === 'string') {
                            message = remoteObj.value || '';
                        } else if (remoteObj.type === 'object' && remoteObj.subtype === 'error') {
                            const desc = remoteObj.description || '';
                            message = desc.split('\n')[0] || '';
                            stack = desc;
                        }

                        if (message) {
                            const errData = {
                                type: ReplayerStatusCode.BROWSER_CONSOLE_ERROR,
                                message: message,
                                stack: stack,
                                timestamp: Date.now()
                            };
                            this.consoleErrors.push(errData);
                            this.emit('console-error', errData);
                        }
                    } catch(e) {}
                });
            }
        });

        this.page.on('pageerror', err => {
            const errData = {
                type: ReplayerStatusCode.BROWSER_CONSOLE_ERROR,
                message: err.message,
                stack: err.stack,
                timestamp: Date.now()
            };
            this.consoleErrors.push(errData);
            this.emit('console-error', errData);
        });

        this.page.on('requestfailed', req => {
            if (req.failure() && req.failure().errorText !== 'net::ERR_ABORTED') {
                const errData = {
                    type: ReplayerStatusCode.REQUEST_ERROR,
                    message: req.failure().errorText,
                    url: req.url(),
                    method: req.method(),
                    timestamp: Date.now()
                };
                this.consoleErrors.push(errData);
                this.emit('console-error', errData);
            }
        });
    }

    async _hideReplayIndicatorSafe() {
        if (this.option.visualEffects && this.effects) {
            try { await this.effects.hideReplayIndicator(); } catch (e) {}
        }
    }

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

        const error = new Error(`Busy Timeout (${timeout}ms)`);
        error.code = ReplayerStatusCode.BUSY_TIMEOUT;
        throw error;
    }

    async _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ===== Action Executors =====

    async _executeAction(action) {
        if (!this.page || this.page.isClosed()) throw new Error('Target closed');
        if (this.status !== ReplayerState.PLAYING) return;

        this.emit('action', action);

        switch (action.type) {
            case 'click':          await this._executeClick(action); break;
            case 'input':          await this._executeInput(action); break;
            case 'change':         await this._executeChange(action); break;
            case 'keydown':        await this._executeKeydown(action); break;
            case 'scroll':         await this._executeScroll(action); break;
            case 'browser_resize': await this._executeBrowserResize(action); break;
            default: console.warn(`Unknown action type: ${action.type}`);
        }
    }

    async _executeClick(action) {
        if (this.option.visualEffects && this.effects) await this.effects.showClick(action.selector, action.x, action.y);
        
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
            await this.page.waitForSelector(action.selector, { timeout: 5000 });
            await this.page.click(action.selector);
        }
    }

    async _executeInput(action) {
        await this.page.waitForSelector(action.selector, { timeout: 5000 });
        if (this.option.visualEffects && this.effects) await this.effects.showInput(action.selector, action.value);
        
        await this.page.evaluate((sel, val, selStart, selEnd) => {
            const el = document.querySelector(sel);
            if (el) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                if (selStart !== undefined && selEnd !== undefined) {
                    if (['text', 'search', 'url', 'tel', 'password'].includes(el.type)) el.setSelectionRange(selStart, selEnd);
                }
            }
        }, action.selector, action.value || '', action.selectionStart, action.selectionEnd);
    }

    async _executeChange(action) {
        await this.page.waitForSelector(action.selector, { timeout: 5000 });
        if (action.checked !== undefined) {
            await this.page.evaluate((sel, checked) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.checked = checked;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, action.selector, action.checked);
        } else {
            const isSelect = await this.page.$eval(action.selector, el => el.tagName === 'SELECT').catch(() => false);
            if (isSelect) await this.page.select(action.selector, action.value);
            else await this.page.evaluate((sel, val) => {
                const el = document.querySelector(sel);
                if (el) {
                    el.value = val;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, action.selector, action.value);
        }
    }

    async _executeKeydown(action) {
        if (this.option.visualEffects && this.effects) await this.effects.showKeyPress(action.key);
        await this.page.keyboard.press(action.key);
    }

    async _executeScroll(action) {
        const duration = action.duration || 300;
        const endX = action.scrollX;
        const endY = action.scrollY;
        const startX = action.startScrollX ?? 0;
        const startY = action.startScrollY ?? 0;

        const scrollFunc = (sel, startX, startY, endX, endY, duration) => {
            return new Promise((resolve) => {
                const el = sel === 'window' ? window : document.querySelector(sel);
                if (!el && sel !== 'window') return resolve();
                const startTime = performance.now();
                function step() {
                    const elapsed = performance.now() - startTime;
                    const progress = Math.min(elapsed / duration, 1);
                    const eased = 1 - Math.pow(1 - progress, 3);
                    if (sel === 'window') window.scrollTo(startX + (endX - startX) * eased, startY + (endY - startY) * eased);
                    else { el.scrollLeft = startX + (endX - startX) * eased; el.scrollTop = startY + (endY - startY) * eased; }
                    if (progress < 1) requestAnimationFrame(step); else resolve();
                }
                requestAnimationFrame(step);
            });
        };

        if (action.selector === 'window') {
            await this.page.evaluate(scrollFunc, 'window', startX, startY, endX, endY, duration);
        } else {
            await this.page.evaluate(scrollFunc, action.selector, startX, startY, endX, endY, duration);
        }
        if (this.option.visualEffects && this.effects) await this.effects.showScroll(action.selector);
    }

    async _executeBrowserResize(action) {
        if (this.option.visualEffects && this.effects) await this.effects.showBrowserResize(action.fromWidth, action.fromHeight, action.toWidth, action.toHeight);
        try {
            const session = await this.page.target().createCDPSession();
            const { windowId } = await session.send('Browser.getWindowForTarget');
            await session.send('Browser.setWindowBounds', { windowId, bounds: { width: action.toWidth, height: action.toHeight } });
            await session.detach();
        } catch(e) { console.warn('Resize failed:', e); }
    }
}

module.exports = { Replayer, ReplayerStatusCode, ReplayerState };