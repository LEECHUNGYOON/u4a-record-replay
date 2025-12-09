const EventEmitter = require('events');
const puppeteer = require('puppeteer');

/**
 * 상태 코드 (RecorderStatusCode)
 * API 호출자는 이 객체만 참조하면 됩니다.
 */
const RecorderStatusCode = {
    // 1. 성공
    SUCCESS: 'SUCCESS',

    // 2. 검증 실패
    NO_URL_FOUND: 'NO_URL_FOUND',
    NO_PAGE_FOUND: 'NO_PAGE_FOUND',
    ALREADY_LAUNCHED: 'ALREADY_LAUNCHED',
    ALREADY_RECORDING: 'ALREADY_RECORDING',
    NOT_RECORDING: 'NOT_RECORDING',

    // 3. 실행 실패
    LAUNCH_FAILED: 'LAUNCH_FAILED',
    RECORDING_START_FAILED: 'RECORDING_START_FAILED',

    // 4. 중단/취소
    ABORTED_BY_USER: 'ABORTED_BY_USER',

    // 5. 수집된 에러 타입
    BROWSER_CONSOLE_ERROR: 'BROWSER_CONSOLE_ERROR',
    REQUEST_ERROR: 'REQUEST_ERROR'
};

/**
 * 내부 상태 머신 정의
 */
const RecorderState = {
    IDLE: 'IDLE',           // 초기/종료 상태
    LAUNCHING: 'LAUNCHING', // 브라우저 실행 중
    READY: 'READY',         // 페이지 로드 완료, 녹화 대기
    RECORDING: 'RECORDING', // 녹화 중
    CLOSING: 'CLOSING'      // 종료 처리 중
};

/**
 * EventEmitter 기반 Recorder 클래스
 */
class Recorder extends EventEmitter {

    constructor(option = {}) {
        super();

        // 기본 옵션
        const defaultOptions = {
            url: '',
            type: 'web',
            stream: true,
            launchOptions: {
                headless: false,
                defaultViewport: null
            },
            gotoOptions: {
                waitUntil: 'load',
                timeout: 30000
            }
        };

        // 옵션 병합
        this.option = {
            ...defaultOptions,
            ...option,
            launchOptions: {
                ...defaultOptions.launchOptions,
                ...(option.launchOptions || {})
            }
        };

        // 상태 관리 (State Machine) - 초기값 IDLE
        this.status = RecorderState.IDLE;

        // 인스턴스 변수
        this.browser = null;
        this.page = null;
        
        // 데이터 저장소
        this.recordedActions = [];
        this.recordedErrors = [];
        this.recordingStartTime = null;
        this.recordingEndTime = null;

        // 중복 주입 방지 플래그
        this._isScriptInjected = false;

        // 종료 시간 기록용 리스너
        this.on('stop', () => {
            if (!this.recordingEndTime) {
                this.recordingEndTime = new Date().toISOString();
            }
        });
    }

    /**
     * [내부] 액션 데이터 수집/전달
     */
    _pushAction(action) {
        const record = {
            ...action,
            timestamp: action.timestamp || Date.now()
        };

        if (this.option.stream) {
            this.emit('action', record);
        }

        this.recordedActions.push(record);
    }

    /**
     * [내부] 에러 수집/전달
     */
    _pushError(type, message, meta = {}) {
        const error = {
            type,
            message,
            timestamp: Date.now(),
            ...meta
        };

        if (this.option.stream) {
            this.emit('console-error', error);
        }
        this.recordedErrors.push(error);
    }

    /**
     * 페이지 실행 (브라우저 열기)
     */
    async launchPage() {
        
        // [검증] IDLE 상태에서만 실행 가능
        if (this.status !== RecorderState.IDLE) {
            return { RETCD: 'E', STCOD: RecorderStatusCode.ALREADY_LAUNCHED, MSGTX: '이미 브라우저가 실행 중이거나 준비 상태입니다.' };
        }
        if (!this.option.url) {
            return { RETCD: 'E', STCOD: RecorderStatusCode.NO_URL_FOUND, MSGTX: 'URL이 설정되지 않았습니다.' };
        }

        // [상태 변경] LAUNCHING
        this.status = RecorderState.LAUNCHING;
        let tempBrowser = null;

        try {
            tempBrowser = await puppeteer.launch(this.option.launchOptions);
            console.log("1 - launch 완료");

            // 체크포인트
            if (this.status === RecorderState.CLOSING) throw new Error(RecorderStatusCode.ABORTED_BY_USER);

            const aPages = await tempBrowser.pages();

            var page = aPages[0];
            if(!page){
                page = await tempBrowser.newPage();
            }
            // const page = await tempBrowser.newPage();
            console.log("2 - newPage 완료");
            
            // 체크포인트
            if (this.status === RecorderState.CLOSING) throw new Error(RecorderStatusCode.ABORTED_BY_USER);

            this.browser = tempBrowser;
            this.page = page;

            // 새 페이지이므로 스크립트 주입 플래그 초기화
            this._isScriptInjected = false;

            // 리스너 등록 (1회만 수행)
            this._registerPuppeteerListeners();

            // 강제 종료(Crash 등) 감지 핸들러
            this.browser.once('disconnected', () => {
                // 의도된 종료(CLOSING)라면 무시
                if (this.status === RecorderState.CLOSING) return;

                // 녹화 중 비정상 종료 시 데이터 보존
                if (this.status === RecorderState.RECORDING) {
                    this.recordingEndTime = new Date().toISOString();
                    this._finalize();
                    this.emit('stop');
                }

                this.emit('close');

                // 상태 초기화 및 알림
                this._resetState();
            });

            await this.page.goto(this.option.url, this.option.gotoOptions);
            console.log("3 - goto 완료");

            // 체크포인트
            if (this.status === RecorderState.CLOSING) throw new Error(RecorderStatusCode.ABORTED_BY_USER);

            // [상태 변경] READY
            this.status = RecorderState.READY;
            return { RETCD: 'S' };

        } catch (error) {

            // 실패 시 브라우저 정리
            if (tempBrowser && tempBrowser.isConnected()) {
                try { await tempBrowser.close(); } catch(e) {}
            }

            // 상태 복구
            if (this.status !== RecorderState.CLOSING) {
                this.status = RecorderState.IDLE;
            }

            // 에러 응답
            if (this.status === RecorderState.CLOSING || error.message === RecorderStatusCode.ABORTED_BY_USER) {
                return { RETCD: 'E', STCOD: RecorderStatusCode.ABORTED_BY_USER, MSGTX: '사용자 요청으로 중단됨' };
            }

            return { RETCD: 'E', STCOD: RecorderStatusCode.LAUNCH_FAILED, MSGTX: error.message };
        }
        
    }

    /**
     * 레코딩 시작
     */
    async startRecording() {
        
        // [검증]
        if (this.status === RecorderState.RECORDING) {
            return { RETCD: 'E', STCOD: RecorderStatusCode.ALREADY_RECORDING, MSGTX: '이미 레코딩 중입니다.' };
        }
        if (this.status !== RecorderState.READY) {
            return { RETCD: 'E', STCOD: RecorderStatusCode.NO_PAGE_FOUND, MSGTX: '페이지가 준비되지 않았습니다. launchPage를 먼저 호출하세요.' };
        }

        try {
            // [상태 변경] RECORDING
            this.status = RecorderState.RECORDING;

            // 데이터 초기화
            this.recordedActions = [];
            this.recordedErrors = [];
            this.recordingStartTime = new Date().toISOString();

            if (this.status === RecorderState.CLOSING) throw new Error(RecorderStatusCode.ABORTED_BY_USER);

            // 1. 초기 해상도 수집
            const initialSize = await this.page.evaluate(() => ({
                width: window.outerWidth,
                height: window.outerHeight
            }));

            if (this.status === RecorderState.CLOSING) throw new Error(RecorderStatusCode.ABORTED_BY_USER);

            this._pushAction({
                type: 'browser_resize',
                fromWidth: initialSize.width,
                fromHeight: initialSize.height,
                toWidth: initialSize.width,
                toHeight: initialSize.height
            });

            // 2. 콜백 노출 (Idempotent)
            if (this.page) {
                try {
                    await this.page.exposeFunction('__u4arecCallback', (action) => {
                        // 녹화 중일 때만 데이터 수집
                        if (this.status === RecorderState.RECORDING) {
                            this._pushAction(action);
                        }
                    });
                } catch (e) {
                    // 이미 존재하는 함수 에러는 무시
                    if (this.status === RecorderState.CLOSING) throw new Error(RecorderStatusCode.ABORTED_BY_USER);
                }
            }

            // 3. 스크립트 주입 (중복 방지 로직 적용)
            const script = this._getInjectionScript();
            const promises = [];

            // 현재 페이지에 즉시 적용
            promises.push(this.page.evaluate(script));

            // 새 탭/새로고침 시 적용 (한 번만 등록)
            if (!this._isScriptInjected) {
                promises.push(this.page.evaluateOnNewDocument(script));
                this._isScriptInjected = true;
            }

            await Promise.all(promises);

            if (this.status === RecorderState.CLOSING) throw new Error(RecorderStatusCode.ABORTED_BY_USER);

            return { RETCD: 'S' };

        } catch (error) {

            // 롤백 (READY 상태로 복귀)
            if (this.status !== RecorderState.CLOSING) {
                this.status = RecorderState.READY;
            }
            this.recordingStartTime = null;

            /**
             * [에러 처리 로직]
             * * 'Target closed' 에러 발생 원인:
             * Puppeteer가 명령(evaluate 등)을 수행하려는데 연결된 브라우저/페이지가 사라진 경우입니다.
             * * 주요 시나리오:
             * 1. [Race Condition] startRecording 실행 도중 코드 다른 곳에서 close()가 호출되어 브라우저가 종료됨.
             * 2. [사용자 개입] 사용자가 실행 중인 크롬 창의 'X' 버튼을 직접 눌러서 닫음.
             * 3. [Crash] 브라우저 탭이 메모리 부족 등으로 강제 종료됨.
             * * 결론:
             * 이는 프로그램 로직 오류(Bug)가 아니라, '작업이 중단된 상황'이므로 
             * 에러가 아닌 ABORTED_BY_USER(사용자 중단) 상태로 처리합니다.
             */
            if (this.status === RecorderState.CLOSING || 
                error.message === RecorderStatusCode.ABORTED_BY_USER || 
                error.message.includes('Target closed')) {
                return { RETCD: 'E', STCOD: RecorderStatusCode.ABORTED_BY_USER, MSGTX: '사용자 중단 또는 브라우저 종료' };
            }

            return { RETCD: 'E', STCOD: RecorderStatusCode.RECORDING_START_FAILED, MSGTX: error.message };
        }
    }

    /**
     * 레코딩 중지
     */
    stopRecording() {

        if (this.status !== RecorderState.RECORDING) {
            return { RETCD: 'E', STCOD: RecorderStatusCode.NOT_RECORDING, MSGTX: '녹화 중이 아닙니다.' };
        }

        this.recordingEndTime = new Date().toISOString();
        this._finalize();
        this.emit('stop');

        // [상태 변경] READY (다시 시작 가능하도록)
        this.status = RecorderState.READY;

        return { RETCD: 'S' };
    }

    /**
     * 메타 정보 조회
     * - 수정됨: _formatDuration 재사용
     */
    getMetadata() {
        const metadata = {
            type: this.option.type,
            url: this.option.url,
            recordingStartTime: this.recordingStartTime,
            recordingEndTime: this.recordingEndTime
        };

        if (this.recordingStartTime && this.recordingEndTime) {
            const startMs = new Date(this.recordingStartTime).getTime();
            const endMs = new Date(this.recordingEndTime).getTime();
            metadata.durationMs = endMs - startMs;
            
            // 공통 메서드 활용
            metadata.duration = this._formatDuration(metadata.durationMs);
        }
        return metadata;
    }

    /**
     * 브라우저 종료
     */
    async close() {
        
        // 이미 닫혔거나 닫는 중이면 무시
        if (this.status === RecorderState.IDLE || this.status === RecorderState.CLOSING) return;

        // [상태 변경] CLOSING (작업 중단 신호)
        this.status = RecorderState.CLOSING;

        try {
            if (this.browser && this.browser.isConnected()) {
                // 1. 현재 열려있는 모든 탭 가져오기
                const pages = await this.browser.pages();

                // 2. 모든 탭 병렬 종료
                // map과 catch를 사용하여 특정 탭 닫기에 실패해도 나머지는 계속 진행되도록 함
                await Promise.all(pages.map(page => page.close().catch(e => {})));

                // 3. 탭 정리가 끝난 후 브라우저 프로세스 종료
                await this.browser.close();
            }
        } catch (e) {
            console.warn('Close warning:', e.message);
        }

        this.emit('close');
        
        // 리소스 및 상태 초기화
        this._resetState();
        
    }


    /**
     * [내부] 데이터 전송 마무리
     */
    _finalize() {
        if (!this.option.stream) {
            if (this.recordedActions.length > 0) this.emit('action', this.recordedActions);
            if (this.recordedErrors.length > 0) this.emit('console-error', this.recordedErrors);
        }
    }

    /**
     * [내부] 상태 리셋
     */
    _resetState() {
        this.browser = null;
        this.page = null;
        this.recordedActions = [];
        this.recordedErrors = [];
        this.recordingStartTime = null;
        this.recordingEndTime = null;
        this._isScriptInjected = false;
        this.status = RecorderState.IDLE;
    }

    /**
     * [내부] 소요 시간 포맷팅 (재사용 가능하도록 분리)
     * @param {number} ms 
     * @returns {string} e.g., "1h 20m 30s"
     */
    _formatDuration(ms) {
        if (!ms || ms < 0) return '0s';
        
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);

        if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
        if (m > 0) return `${m}m ${s % 60}s`;
        return `${s}s`;
    }

    /**
     * [내부] Puppeteer 리스너 등록
     */
    _registerPuppeteerListeners() {
        if (!this.page) return;

        // 콘솔 에러
        this.page.on('console', (msg) => {
            if (this.status !== RecorderState.RECORDING) return;
            if (msg.type() === 'error') {
                msg.args().forEach(arg => {
                    try {
                        const val = arg.remoteObject();
                        const text = val.type === 'string' ? val.value : (val.description || 'Unknown Error');
                        this._pushError(RecorderStatusCode.BROWSER_CONSOLE_ERROR, text.split('\n')[0], { stack: text });
                    } catch (e) {}
                });
            }
        });

        // 페이지 에러
        this.page.on('pageerror', (err) => {
            if (this.status !== RecorderState.RECORDING) return;
            this._pushError(RecorderStatusCode.BROWSER_CONSOLE_ERROR, err.message, { stack: err.stack });
        });

        // 요청 실패
        this.page.on('requestfailed', (req) => {
            if (this.status !== RecorderState.RECORDING) return;
            const failure = req.failure();
            if (failure?.errorText === 'net::ERR_ABORTED') return;
            this._pushError(RecorderStatusCode.REQUEST_ERROR, failure?.errorText || 'Failed', { url: req.url(), method: req.method() });
        });
    }

    /**
     * [내부] 브라우저 주입 스크립트 (이벤트 감지 로직 포함)
     */
    _getInjectionScript() {
        return function() {
            // [중복 실행 방지]
            if (window.u4arec) return;

            window.u4arec = {
                onUserAction: (action) => window.__u4arecCallback && window.__u4arecCallback(action)
            };

            // Selector 생성 함수
            function getSelector(el) {
                if (el.id) return '#' + el.id;
                if (el.name) return '[name="' + el.name + '"]';
                if (el.className && typeof el.className === 'string') {
                    const classes = el.className.trim().split(/\s+/).join('.');
                    if (classes) return el.tagName.toLowerCase() + '.' + classes;
                }
                const parent = el.parentElement;
                if (parent) {
                    const index = Array.from(parent.children).indexOf(el) + 1;
                    return getSelector(parent) + ' > ' + el.tagName.toLowerCase() + ':nth-child(' + index + ')';
                }
                return el.tagName.toLowerCase();
            }

            // 이벤트 리스너 등록 함수
            function registerEventListeners() {
                // 1. Click
                document.addEventListener('click', (e) => {
                    const actionData = {
                        type: 'click',
                        selector: getSelector(e.target),
                        x: e.clientX,
                        y: e.clientY
                    };
                    if (e.target.type === 'checkbox' || e.target.type === 'radio') {
                        actionData.checked = e.target.checked;
                    }
                    window.u4arec.onUserAction(actionData);
                }, true);

                // 2. Input (키보드 입력 값)
                document.addEventListener('input', (e) => {
                    if (e.target.type === 'checkbox' || e.target.type === 'radio') return;
                    
                    const action = {
                        type: 'input',
                        selector: getSelector(e.target),
                        value: e.target.value
                    };
                    
                    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                        action.selectionStart = e.target.selectionStart;
                        action.selectionEnd = e.target.selectionEnd;
                    }
                    
                    window.u4arec.onUserAction(action);
                }, true);

                // 3. Change (값 변경 완료)
                document.addEventListener('change', (e) => {
                    const actionData = {
                        type: 'change',
                        selector: getSelector(e.target)
                    };
                    if (e.target.type === 'checkbox' || e.target.type === 'radio') {
                        actionData.checked = e.target.checked;
                    } else {
                        actionData.value = e.target.value;
                    }
                    window.u4arec.onUserAction(actionData);
                }, true);

                // 4. Keydown (특수키 등)
                document.addEventListener('keydown', (e) => {
                    if (e.ctrlKey || e.altKey || e.metaKey) return;
                    
                    const captureKeys = [
                        'Enter', 'Tab', 'Escape', 
                        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 
                        'Backspace', 'Delete', 'Home', 'End', 
                        'PageUp', 'PageDown', 'Insert', ' '
                    ];
                    
                    if (captureKeys.includes(e.key)) {
                        window.u4arec.onUserAction({
                            type: 'keydown',
                            selector: getSelector(e.target),
                            key: e.key === ' ' ? 'Space' : e.key
                        });
                    }
                }, true);

                // 5. Scroll
                let scrollTimeout = null;
                let scrollStartX = null, scrollStartY = null, scrollStartTime = null, scrollTarget = null;

                document.addEventListener('scroll', (e) => {
                    const target = e.target === document ? 'window' : getSelector(e.target);
                    const currentX = window.scrollX || e.target.scrollLeft || 0;
                    const currentY = window.scrollY || e.target.scrollTop || 0;

                    if (scrollStartTime === null || scrollTarget !== target) {
                        scrollStartX = currentX;
                        scrollStartY = currentY;
                        scrollStartTime = Date.now();
                        scrollTarget = target;
                    }

                    clearTimeout(scrollTimeout);
                    scrollTimeout = setTimeout(() => {
                        window.u4arec.onUserAction({
                            type: 'scroll',
                            selector: scrollTarget,
                            startScrollX: scrollStartX,
                            startScrollY: scrollStartY,
                            scrollX: currentX,
                            scrollY: currentY,
                            duration: Date.now() - scrollStartTime
                        });
                        scrollStartX = null; scrollStartY = null; scrollStartTime = null; scrollTarget = null;
                    }, 150);
                }, true);

                // 6. Resize
                let resizeTimeout = null;
                let initialWidth = window.outerWidth;
                let initialHeight = window.outerHeight;

                window.addEventListener('resize', () => {
                    clearTimeout(resizeTimeout);
                    resizeTimeout = setTimeout(() => {
                        const currentWidth = window.outerWidth;
                        const currentHeight = window.outerHeight;
                        
                        if (initialWidth !== currentWidth || initialHeight !== currentHeight) {
                            window.u4arec.onUserAction({
                                type: 'browser_resize',
                                fromWidth: initialWidth,
                                fromHeight: initialHeight,
                                toWidth: currentWidth,
                                toHeight: currentHeight
                            });
                            initialWidth = currentWidth;
                            initialHeight = currentHeight;
                        }
                    }, 300);
                });
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', registerEventListeners);
            } else {
                registerEventListeners();
            }
        };
    }
}

module.exports = { Recorder, RecorderStatusCode };