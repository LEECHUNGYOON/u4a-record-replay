const EventEmitter = require('events');
const puppeteer = require('puppeteer');

/**
 * 상태 코드 (RecorderStatusCode)
 * 
 * [메서드 리턴 - 실패]
 * - NO_URL_FOUND     : URL이 설정되지 않음 (launchPage)
 * - LAUNCH_FAILED    : 브라우저 실행 실패 (launchPage)
 * - NO_PAGE_FOUND    : 페이지가 없음 (startRecording)
 * - NOT_RECORDING    : 레코딩 중이 아님 (stopRecording)
 * 
 * [브라우저 에러]
 * - BROWSER_CONSOLE_ERROR : 브라우저 콘솔 에러 (console.error, uncaught exception)
 * - REQUEST_ERROR         : 네트워크 요청 실패
 */
const RecorderStatusCode = {
    
    // 메서드 리턴 - 실패
    NO_URL_FOUND: 'NO_URL_FOUND',
    LAUNCH_FAILED: 'LAUNCH_FAILED',
    NO_PAGE_FOUND: 'NO_PAGE_FOUND',
    NOT_RECORDING: 'NOT_RECORDING',
    ALREADY_LAUNCHED: 'ALREADY_LAUNCHED',
    
    // 브라우저 에러
    BROWSER_CONSOLE_ERROR: 'BROWSER_CONSOLE_ERROR',
    REQUEST_ERROR: 'REQUEST_ERROR'
};

/**
 * EventEmitter 기반 Recorder 클래스
 * 
 * 이벤트 (레코딩 중에만 발생):
 *   - 'action': 사용자 액션 데이터
 *   - 'error':  브라우저 에러 (콘솔, 페이지, 네트워크)
 *   - 'stop':   레코딩 중지 시
 *   - 'close':  브라우저 닫힘 시
 * 
 * stream 옵션:
 *   - true:  실시간 개별 전달
 *   - false: 종료 시 배열로 일괄 전달
 * 
 * 메서드 리턴:
 *   - RETCD: 'S' (성공) | 'E' (실패)
 *   - STCOD: 상태코드 (실패 시)
 *   - MSGTX: 메시지 (실패 시)
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
            }
        };

        // Deep merge를 위한 헬퍼
        this.option = {
            ...defaultOptions,
            ...option,
            launchOptions: {
                ...defaultOptions.launchOptions,
                ...(option.launchOptions || {})
            }
        };

        // URL 검증
        if (!this.option.url) {
            throw new Error('URL은 필수입니다. option.url을 설정하세요.');
        }

        // Chrome 실행 경로 검증
        if (!this.option.launchOptions.executablePath) {
            throw new Error('Chrome 실행 경로가 필요합니다. option.launchOptions.executablePath를 설정하세요.');
        }

        this.browser = null;
        this.page = null;
        this.isRecording = false;
        this.recordedActions = [];
        this.recordedErrors = [];

        // 레코딩 시간 추적
        this.recordingStartTime = null;
        this.recordingEndTime = null;

        // stop 이벤트 리스너 등록 - 종료 시간 기록용
        this.on('stop', () => {
            if (!this.recordingEndTime) {
                this.recordingEndTime = new Date().toISOString();
            }
        });

    } // end of constructor

    /**
     * 액션 수집/전달
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
     * 에러 수집/전달
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
     * 페이지 실행
     * @returns {Object} { RETCD: 'S'|'E', STCOD?: string, MSGTX?: string }
     */
    async launchPage() {

        // 🆕 이미 브라우저가 실행 중이면 에러
        if (this.browser && this.browser.isConnected()) {
            return { 
                RETCD: 'E', 
                STCOD: RecorderStatusCode.ALREADY_LAUNCHED, 
                MSGTX: '이미 브라우저가 실행 중입니다. 새 브라우저가 필요하면 먼저 close()를 호출하거나 새 인스턴스를 생성하세요.' 
            };
        }

        if (!this.option.url) {
            return { RETCD: 'E', STCOD: RecorderStatusCode.NO_URL_FOUND, MSGTX: 'URL이 설정되지 않았습니다.' };
        }

        try {
            this.browser = await puppeteer.launch(this.option.launchOptions);
            this.page = await this.browser.newPage();

            // 브라우저 강제 종료 감지
            this.browser.once('disconnected', () => {

                if (this._isClosing) return;

                if (this.isRecording) {
                    this._finalize();
                    this.emit('stop');
                }

                this.browser = null;
                this.page = null;

                this.emit('close');
            });

            await this.page.goto(this.option.url);

            return { RETCD: 'S' };

        } catch (error) {
            return { RETCD: 'E', STCOD: RecorderStatusCode.LAUNCH_FAILED, MSGTX: error.message };
        }
    }

    /**
     * 레코딩 시작
     * @returns {Object} { RETCD: 'S'|'E', STCOD?: string, MSGTX?: string }
     */
    async startRecording() {
        if (!this.page) {
            return { RETCD: 'E', STCOD: RecorderStatusCode.NO_PAGE_FOUND, MSGTX: '먼저 페이지를 실행하세요.' };
        }

        this.isRecording = true;
        this.recordedActions = [];
        this.recordedErrors = [];

        // 레코딩 시작 시간 기록
        this.recordingStartTime = new Date().toISOString();

        // 초기 브라우저 크기를 첫 액션으로 기록
        const initialSize = await this.page.evaluate(() => ({
            width: window.outerWidth,
            height: window.outerHeight
        }));

        this._pushAction({
            type: 'browser_resize',
            fromWidth: initialSize.width,
            fromHeight: initialSize.height,
            toWidth: initialSize.width,
            toHeight: initialSize.height
        });

        // 브라우저 콘솔 에러 캡처
        this.page.on('console', async (msg) => {
            if (this.isRecording && msg.type() === 'error') {
                const args = msg.args();
                for (const arg of args) {
                    const remoteObj = arg.remoteObject();                    

                    if (remoteObj.type === 'string') {
                        this._pushError(RecorderStatusCode.BROWSER_CONSOLE_ERROR, remoteObj.value || '', { stack: '' });
                    }

                    else if (remoteObj.type === 'object' && remoteObj.subtype === 'error') {
                        const description = remoteObj.description || '';
                        const message = description.split('\n')[0] || '';

                        this._pushError(RecorderStatusCode.BROWSER_CONSOLE_ERROR, message, { stack: description });
                    }
                }
            }
        });

        // 페이지 에러 캡처 (uncaught exception)
        this.page.on('pageerror', (error) => {
            if (this.isRecording) {
                this._pushError(RecorderStatusCode.BROWSER_CONSOLE_ERROR, error.message, {
                    stack: error.stack || ''
                });
            }
        });

        // 네트워크 요청 실패 캡처
        this.page.on('requestfailed', (request) => {
            if (this.isRecording) {
                const failure = request.failure();
                this._pushError(RecorderStatusCode.REQUEST_ERROR, failure?.errorText || 'Request failed', {
                    url: request.url(),
                    method: request.method()
                });
            }
        });

        try {
            await this.page.exposeFunction('__u4arecCallback', (action) => {
                if (this.isRecording) {
                    this._pushAction(action);
                }
            });
        } catch (e) {
            // 이미 expose된 경우 무시
        }

        await this.page.evaluate(this._getInjectionScript());
        await this.page.evaluateOnNewDocument(this._getInjectionScript());

        return { RETCD: 'S' };
    }

    /**
     * 브라우저에 주입할 스크립트
     */
    _getInjectionScript() {

        return function () {

            window.u4arec = {
                onUserAction: (action) => window.__u4arecCallback(action)
            };

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

            function registerEventListeners() {
                document.addEventListener('click', (e) => {
                    const actionData = {
                        type: 'click',
                        selector: getSelector(e.target),
                        x: e.clientX,
                        y: e.clientY
                    };
                    
                    // 🆕 체크박스/라디오 상태 기록
                    if (e.target.type === 'checkbox' || e.target.type === 'radio') {
                        actionData.checked = e.target.checked;
                    }
                    
                    window.u4arec.onUserAction(actionData);
                }, true);

                document.addEventListener('input', (e) => {
                    // 🆕 체크박스/라디오는 input 이벤트 무시 (click/change에서 처리)
                    if (e.target.type === 'checkbox' || e.target.type === 'radio') {
                        return;
                    }
                    
                    const action = {
                        type: 'input',
                        selector: getSelector(e.target),
                        value: e.target.value
                    };
                    
                    // 커서 위치 기록 (input, textarea만)
                    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                        action.selectionStart = e.target.selectionStart;
                        action.selectionEnd = e.target.selectionEnd;
                    }
                    
                    window.u4arec.onUserAction(action);
                }, true);

                document.addEventListener('change', (e) => {
                    const actionData = {
                        type: 'change',
                        selector: getSelector(e.target)
                    };
                    
                    // 🆕 체크박스/라디오는 checked 상태 기록
                    if (e.target.type === 'checkbox' || e.target.type === 'radio') {
                        actionData.checked = e.target.checked;
                    } else {
                        // 일반 input, select 등은 value 기록
                        actionData.value = e.target.value;
                    }
                    
                    window.u4arec.onUserAction(actionData);
                }, true);

                document.addEventListener('keydown', (e) => {
                    if (e.ctrlKey || e.altKey || e.metaKey) {
                        return;
                    }
                    
                    const captureKeys = [
                        'Enter',
                        'Tab',
                        'Escape',
                        'ArrowUp',
                        'ArrowDown',
                        'ArrowLeft',
                        'ArrowRight',
                        'Backspace',
                        'Delete',
                        'Home',
                        'End',
                        'PageUp',
                        'PageDown',
                        'Insert',
                        ' '
                    ];
                    
                    if (captureKeys.includes(e.key)) {
                        window.u4arec.onUserAction({
                            type: 'keydown',
                            selector: getSelector(e.target),
                            key: e.key === ' ' ? 'Space' : e.key
                        });
                    }
                }, true);

                /**
                 * 스크롤 이벤트 감지
                 */
                let scrollStartX = null;
                let scrollStartY = null;
                let scrollStartTime = null;
                let scrollTimeout = null;
                let scrollTarget = null;

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
                        const duration = Date.now() - scrollStartTime;

                        window.u4arec.onUserAction({
                            type: 'scroll',
                            selector: scrollTarget,
                            startScrollX: scrollStartX,
                            startScrollY: scrollStartY,
                            scrollX: currentX,
                            scrollY: currentY,
                            duration: duration
                        });

                        scrollStartX = null;
                        scrollStartY = null;
                        scrollStartTime = null;
                        scrollTarget = null;
                    }, 150);
                }, true);

                // 🆕 Browser Resize 이벤트 감지
                let resizeTimeout = null;
                let initialWidth = window.outerWidth;   // ✅ outerWidth 사용
                let initialHeight = window.outerHeight; // ✅ outerHeight 사용

                window.addEventListener('resize', () => {
                    clearTimeout(resizeTimeout);
                    
                    resizeTimeout = setTimeout(() => {
                        const currentWidth = window.outerWidth;   // ✅ outerWidth 사용
                        const currentHeight = window.outerHeight; // ✅ outerHeight 사용
                        
                        // 실제로 크기가 변경된 경우만 기록
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
                    }, 300); // 300ms 디바운스
                });

            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', registerEventListeners);
            } else {
                registerEventListeners();
            }
        };
    }

    /**
     * 종료 처리
     */
    _finalize() {
        this.isRecording = false;

        // stream: false인 경우 일괄 전달
        if (!this.option.stream) {
            if (this.recordedActions.length > 0) {
                this.emit('action', this.recordedActions);
            }
            if (this.recordedErrors.length > 0) {
                this.emit('console-error', this.recordedErrors);
            }
        }
    }

    /**
     * 레코딩 중지
     * @returns {Object} { RETCD: 'S'|'E', STCOD?: string, MSGTX?: string }
     */
    stopRecording() {

        if (!this.isRecording) {
            return { RETCD: 'E', STCOD: RecorderStatusCode.NOT_RECORDING, MSGTX: '진행 중인 레코딩이 없습니다.' };
        }

        // 레코딩 종료 시간 기록
        this.recordingEndTime = new Date().toISOString();

        this._finalize();
        this.emit('stop');

        return { RETCD: 'S' };
    }

    /**
     * 메타 정보 조회
     */
    getMetadata() {

        const metadata = {
            type: this.option.type,
            url: this.option.url,
            recordingStartTime: this.recordingStartTime,
            recordingEndTime: this.recordingEndTime
        };

        // 소요 시간 계산 (밀리초)
        if (this.recordingStartTime && this.recordingEndTime) {
            const startMs = new Date(this.recordingStartTime).getTime();
            const endMs = new Date(this.recordingEndTime).getTime();
            metadata.durationMs = endMs - startMs;
            
            // 사람이 읽기 쉬운 형식 추가 (선택사항)
            metadata.duration = this._formatDuration(metadata.durationMs);
        }

        return metadata;
    }

    /**
     * 소요 시간을 읽기 쉬운 형식으로 변환
     */
    _formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    /**
     * 브라우저 닫기
     */
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
        this.emit('close');
        
        this.recordedActions = [];
        this.recordedErrors = [];
        
        // 시간 정보 초기화
        this.recordingStartTime = null;
        this.recordingEndTime = null;
        
        this._isClosing = false;
    }
}

module.exports = { Recorder, RecorderStatusCode };