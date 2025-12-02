const puppeteer = require('puppeteer');

class Replayer {
    constructor(option = {}) {

        this.option = {
            url: option.url || '',
            type: option.type || 'web',
            // busyIndicator 대기 설정
            busyIndicatorSelector: option.busyIndicatorSelector || '.u4aUiBusyIndicator, .sapUiLocalBusyIndicator, .U4A_progress',
            busyTimeout: option.busyTimeout || 60000 * 5, // 5분
            ...option
        };

        this.browser = null;
        this.page = null;
        this.isPlaying = false;
        this.consoleErrors = [];
    }

    // 1. 브라우저 실행 및 페이지 열기
    async launchPage(options = {}) {

        const defaultOptions = {
            headless: false,
            defaultViewport: null,
        };

        const launchOptions = { ...defaultOptions, ...options };

        this.browser = await puppeteer.launch(launchOptions);
        this.page = await this.browser.newPage();

        // 브라우저 강제 종료 감지
        this.browser.on('disconnected', () => {
            console.log('브라우저가 강제 종료되었습니다.');
            this.stop();
            this.browser = null;
            this.page = null;
        });

        // 콘솔 에러 수집
        this.consoleErrors = [];
        this.page.on('console', (msg) => {
            if (msg.type() === 'error') {
                this.consoleErrors.push({
                    type: 'console',
                    message: msg.text(),
                    timestamp: Date.now()
                });
            }
        });

        // 페이지 에러 수집 (uncaught exception)
        this.page.on('pageerror', (error) => {
            this.consoleErrors.push({
                type: 'pageerror',
                message: error.message,
                timestamp: Date.now()
            });
        });

        await this.page.goto(this.option.url, { waitUntil: 'networkidle2' });

        console.log('페이지 실행 완료.');
    }

    // 2. Replay 실행
    async play(recordData) {
        if (!this.page) {
            console.error('먼저 페이지를 실행하세요.');
            return;
        }

        if (!recordData || !recordData.actions) {
            console.error('유효한 recordData가 필요합니다.');
            return;
        }

        // JSON의 type으로 option 업데이트
        if (recordData.type) {
            this.option.type = recordData.type;
        }

        this.isPlaying = true;
        console.log(`Replay 시작... 타입: ${this.option.type}, 액션 수: ${recordData.actions.length}`);

        // 타이밍 계산을 위한 변수
        const actions = recordData.actions;
        let timeOffset = 0; // busy로 인해 밀린 시간 누적

        for (let i = 0; i < actions.length; i++) {
            // 브라우저 종료 또는 중지 요청 체크
            if (!this.isPlaying || !this.browser || !this.page) {
                console.log('Replay 중지됨.');
                break;
            }

            const action = actions[i];
            console.log(`[${i + 1}/${actions.length}] 액션 실행:`, action.type, action.selector);

            try {
                // busyIndicator 대기 및 타이밍 재계산
                const busyStartTime = Date.now();
                await this._waitForBusyIndicator();
                const busyElapsed = Date.now() - busyStartTime;

                // 다음 액션까지의 원래 예상 대기 시간 계산
                let expectedDelay = 0;
                if (i > 0 && actions[i - 1].timestamp && action.timestamp) {
                    expectedDelay = action.timestamp - actions[i - 1].timestamp;
                }

                // busy 시간이 예상 대기 시간보다 길면 offset 누적
                if (busyElapsed > expectedDelay) {
                    const additionalOffset = busyElapsed - expectedDelay;
                    timeOffset += additionalOffset;
                    console.log(`busy 지연 발생: +${additionalOffset}ms (총 offset: ${timeOffset}ms)`);
                }

                // 브라우저 종료 체크
                if (!this.isPlaying || !this.browser) break;

                // 액션 실행
                await this._executeAction(action);

                // 브라우저 종료 체크
                if (!this.isPlaying || !this.browser) break;

                // 다음 액션까지 대기 시간 계산 (timestamp 기반)
                if (i < actions.length - 1) {
                    const nextAction = actions[i + 1];
                    let delay = nextAction.timestamp - action.timestamp;
                    
                    // offset만큼 차감 (최소 0)
                    delay = Math.max(delay - timeOffset, 0);
                    
                    // offset 소진
                    timeOffset = Math.max(timeOffset - (nextAction.timestamp - action.timestamp), 0);
                    
                    if (delay > 0) {
                        await this._delay(delay);
                    }
                }

            } catch (error) {
                // 브라우저 종료로 인한 에러는 무시
                if (!this.browser || !this.isPlaying) {
                    console.log('브라우저 종료로 인해 Replay 중단.');
                    break;
                }
                console.error(`액션 실행 실패 [${i + 1}]:`, error.message);
                throw error;
            }
        }

        this.isPlaying = false;
        console.log('Replay 완료.');

        // 결과 반환
        return {
            success: this.consoleErrors.length === 0,
            consoleErrors: this.consoleErrors
        };
    }

    // 3. Replay 중지
    stop() {
        this.isPlaying = false;
        console.log('Replay 중지 요청.');
    }

    // 4. 브라우저 닫기
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
        this.isPlaying = false;
        console.log('브라우저 종료.');
    }

    // ===== Private Methods =====

    // busyIndicator가 사라질 때까지 대기
    async _waitForBusyIndicator() {
        const selector = this.option.busyIndicatorSelector;
        const timeout = this.option.busyTimeout;
        const interval = 100; // 100ms 간격으로 체크
        let elapsed = 0;

        while (elapsed < timeout) {
            const isBusy = await this.page.evaluate((sel) => {
                const busy = document.querySelector(sel);
                if (!busy) return false;
                const style = window.getComputedStyle(busy);
                return style.display !== 'none' && style.visibility !== 'hidden' && !busy.hidden;
            }, selector);

            if (!isBusy) {
                return; // busy 아니면 즉시 리턴
            }

            await this._delay(interval);
            elapsed += interval;
        }

        // timeout 초과 시 exception
        throw new Error(`busyIndicator 대기 시간 초과 (${timeout}ms). selector: ${selector}`);
    }

    // 개별 액션 실행
    async _executeAction(action) {
        switch (action.type) {
            case 'click':
                await this._executeClick(action);
                break;

            case 'input':
                await this._executeInput(action);
                break;

            case 'change':
                await this._executeChange(action);
                break;

            case 'keydown':
                await this._executeKeydown(action);
                break;

            case 'scroll':
                await this._executeScroll(action);
                break;

            default:
                console.warn(`알 수 없는 액션 타입: ${action.type}`);
        }
    }

    // Click 액션 실행
    async _executeClick(action) {
        try {
            await this.page.waitForSelector(action.selector, { timeout: 5000 });
            await this.page.click(action.selector);
        } catch (error) {
            // selector로 찾지 못하면 좌표로 클릭 시도
            if (action.x !== undefined && action.y !== undefined) {
                await this.page.mouse.click(action.x, action.y);
            } else {
                throw error;
            }
        }
    }

    // Input 액션 실행
    async _executeInput(action) {
        await this.page.waitForSelector(action.selector, { timeout: 5000 });
        
        // 기존 값 지우고 새 값 입력 (블록 없이)
        await this.page.evaluate((sel, val) => {
            const el = document.querySelector(sel);
            if (el) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, action.selector, action.value || '');
    }

    // Change 액션 실행 (select 등)
    async _executeChange(action) {
        await this.page.waitForSelector(action.selector, { timeout: 5000 });
        
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

    // Keydown 액션 실행
    async _executeKeydown(action) {
        await this.page.keyboard.press(action.key);
    }

    // Scroll 액션 실행
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
                    
                    function easeOutCubic(t) {
                        return 1 - Math.pow(1 - t, 3);
                    }

                    function step() {
                        const elapsed = performance.now() - startTime;
                        const progress = Math.min(elapsed / duration, 1);
                        const eased = easeOutCubic(progress);

                        const currentX = startX + (endX - startX) * eased;
                        const currentY = startY + (endY - startY) * eased;

                        window.scrollTo(currentX, currentY);

                        if (progress < 1) {
                            requestAnimationFrame(step);
                        } else {
                            resolve();
                        }
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

                    function easeOutCubic(t) {
                        return 1 - Math.pow(1 - t, 3);
                    }

                    function step() {
                        const elapsed = performance.now() - startTime;
                        const progress = Math.min(elapsed / duration, 1);
                        const eased = easeOutCubic(progress);

                        el.scrollLeft = startX + (endX - startX) * eased;
                        el.scrollTop = startY + (endY - startY) * eased;

                        if (progress < 1) {
                            requestAnimationFrame(step);
                        } else {
                            resolve();
                        }
                    }

                    requestAnimationFrame(step);
                });
            }, action.selector, startX, startY, endX, endY, duration);
        }
    }

    // 딜레이 유틸리티
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = { Replayer };