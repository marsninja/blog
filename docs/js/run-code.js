let pyodideWorker = null;
let pyodideReady = false;
let pyodideInitPromise = null;
let monacoLoaded = false;
let monacoLoadPromise = null;
let sab = null;
const initializedBlocks = new WeakSet();
const allEditors = [];

// Initialize Pyodide Worker
function initPyodideWorker() {
    if (pyodideWorker) return pyodideInitPromise;
    if (pyodideInitPromise) return pyodideInitPromise;

    const DATA_CAP = 4096;
    sab = new SharedArrayBuffer(8 + DATA_CAP);
    ctrl = new Int32Array(sab, 0, 2);
    dataBytes = new Uint8Array(sab, 8);

    pyodideWorker = new Worker("/js/pyodide-worker.js");
    pyodideInitPromise = new Promise((resolve, reject) => {
        pyodideWorker.onmessage = (event) => {
            if (event.data.type === "ready") {
                pyodideReady = true;
                resolve();
            }
        };
        pyodideWorker.onerror = (e) => reject(e);
    });
    pyodideWorker.postMessage({ type: "init", sab });
    return pyodideInitPromise;
}

function executeJacCodeInWorker(code, inputHandler, commandType = "run", language = "jac") {
    return new Promise(async (resolve, reject) => {
        await initPyodideWorker();
        const handleMessage = async (event) => {
            let message;
            if (typeof event.data === "string") {
                message = JSON.parse(event.data);
            } else {
                message = event.data;
            }

            if (message.type === "streaming_output") {
                // Handle real-time output streaming
                const event = new CustomEvent('jacOutputUpdate', {
                    detail: { output: message.output, stream: message.stream }
                });
                document.dispatchEvent(event);
            } else if (message.type === "execution_complete") {
                pyodideWorker.removeEventListener("message", handleMessage);
                resolve("");
            } else if (message.type === "input_request") {
                console.log("Input requested");
                try {
                    const userInput = await inputHandler(message.prompt || "Enter input:");

                    const enc = new TextEncoder();
                    const bytes = enc.encode(userInput);
                    const n = Math.min(bytes.length, dataBytes.length);
                    dataBytes.set(bytes.subarray(0, n), 0);

                    Atomics.store(ctrl, 1, n);
                    Atomics.store(ctrl, 0, 1);
                    Atomics.notify(ctrl, 0, 1);
                } catch (error) {
                    pyodideWorker.removeEventListener("message", handleMessage);
                    reject(error);
                }
            } else if (message.type === "error") {
                pyodideWorker.removeEventListener("message", handleMessage);
                reject(message.error);
            }
        };
        pyodideWorker.addEventListener("message", handleMessage);
        pyodideWorker.postMessage({ type: commandType, code, language });
    });
}

function runJacCodeInWorker(code, inputHandler) {
    return executeJacCodeInWorker(code, inputHandler, "run");
}

function serveJacCodeInWorker(code, inputHandler) {
    return executeJacCodeInWorker(code, inputHandler, "serve");
}

// Detect current Material theme
function getCurrentTheme() {
    const palette = document.querySelector('[data-md-color-scheme]');
    if (palette) {
        return palette.getAttribute('data-md-color-scheme');
    }
    return 'slate'; // default to dark
}

// Update all Monaco editors to match the current theme
function updateMonacoTheme() {
    const currentScheme = getCurrentTheme();
    const themeToUse = currentScheme === 'default' ? 'jac-theme-light' : 'jac-theme-dark';

    allEditors.forEach(editor => {
        monaco.editor.setTheme(themeToUse);
    });
}

// Load Monaco Editor Globally
function loadMonacoEditor() {
    if (monacoLoaded) return monacoLoadPromise;
    if (monacoLoadPromise) return monacoLoadPromise;

    monacoLoadPromise = new Promise((resolve, reject) => {
        require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs' } });
        require(['vs/editor/editor.main'], function () {
            monacoLoaded = true;
            monaco.languages.register({ id: 'jac' });
            monaco.languages.setMonarchTokensProvider('jac', window.jaclangMonarchSyntax);

            fetch('/../playground/language-configuration.json')
                .then(resp => resp.json())
                .then(config => monaco.languages.setLanguageConfiguration('jac', config));

            // Define dark theme
            monaco.editor.defineTheme('jac-theme-dark', {
                base: 'vs-dark',
                inherit: true,
                rules: window.jacThemeRulesDark,
                colors: window.jacThemeColorsDark
            });

            // Define light theme
            monaco.editor.defineTheme('jac-theme-light', {
                base: 'vs',
                inherit: true,
                rules: window.jacThemeRulesLight,
                colors: window.jacThemeColorsLight
            });

            // Set initial theme based on current MkDocs theme
            const currentScheme = getCurrentTheme();
            const initialTheme = currentScheme === 'default' ? 'jac-theme-light' : 'jac-theme-dark';
            monaco.editor.setTheme(initialTheme);

            resolve();
        }, reject);
    });
    console.log("Loading Monaco Editor...");
    return monacoLoadPromise;
}

// Setup Code Block with Monaco Editor
async function setupCodeBlock(div) {
    if (div._monacoInitialized) return;

    div._monacoInitialized = true;
    const originalCode = div.textContent.trim();
    const language = div.getAttribute('data-lang') || 'jac';

    div.innerHTML = `
        <div class="jac-code-loading" style="padding: 10px; font-style: italic; color: gray;">
            Loading editor...
        </div>
    `;

    await loadMonacoEditor();

    div.innerHTML = `
    <div class="jac-code" style="border: 1px solid #ccc;"></div>
    <div class="button-container" style="display: flex; gap: 8px;">
        <button class="md-button md-button--primary run-code-btn">Run</button>
        <button class="md-button md-button--primary serve-code-btn" style="background: linear-gradient(90deg, #0288d1 0%, #03a9f4 100%);">Serve</button>
    </div>
    <div class="input-dialog" style="display: none;">
        <div style="display: flex; gap: 10px; align-items: center;">
            <div class="input-prompt"></div>
            <input type="text" class="user-input" placeholder="Enter input...">
            <button class="submit-input">Submit</button>
            <button class="cancel-input">Cancel</button>
        </div>
    </div>
    <pre class="code-output" style="display:none; white-space: pre-wrap;"></pre>
    `;

    const container = div.querySelector(".jac-code");
    const runButton = div.querySelector(".run-code-btn");
    const serveButton = div.querySelector(".serve-code-btn");
    const outputBlock = div.querySelector(".code-output");
    const inputDialog = div.querySelector(".input-dialog");
    const inputPrompt = div.querySelector(".input-prompt");
    const userInput = div.querySelector(".user-input");
    const submitButton = div.querySelector(".submit-input");
    const cancelButton = div.querySelector(".cancel-input");

    // Handle button visibility based on classnames
    serveButton.style.display = 'none';
    if (div.classList.contains('serve-only')) {
        runButton.style.display = 'none';
        serveButton.style.display = 'inline-block';
    } else if (div.classList.contains('run-serve')) {
        serveButton.style.display = 'inline-block';
    }

    // Determine initial theme
    const currentScheme = getCurrentTheme();
    const initialTheme = currentScheme === 'default' ? 'jac-theme-light' : 'jac-theme-dark';

    const editor = monaco.editor.create(container, {
        value: originalCode || (language === 'python' ? '# Write your Python code here' : '# Write your Jac code here'),
        language: language === 'python' ? 'python' : 'jac',
        theme: initialTheme,
        scrollBeyondLastLine: false,
        scrollbar: {
            vertical: 'hidden',
            handleMouseWheel: false,
        },
        minimap: {
            enabled: false
        },
        automaticLayout: true,
        padding: {
            top: 10,
            bottom: 10
        }
    });

    // Track this editor for theme updates
    allEditors.push(editor);

    // Update editor height based on content
    function updateEditorHeight() {
        const lineCount = editor.getModel().getLineCount();
        const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
        const height = lineCount * lineHeight + 20;
        container.style.height = `${height}px`;
        editor.layout();
    }
    updateEditorHeight();
    editor.onDidChangeModelContent(updateEditorHeight);

    // Custom input handler function
    function createInputHandler() {
        return function(prompt) {
            return new Promise((resolve, reject) => {
                inputPrompt.textContent = prompt;
                inputDialog.style.display = "block";
                userInput.value = "";
                userInput.focus();

                const handleSubmit = () => {
                    const value = userInput.value;
                    inputDialog.style.display = "none";
                    // Add the input to output for visibility
                    outputBlock.textContent += `${prompt}${value}\n`;
                    outputBlock.scrollTop = outputBlock.scrollHeight;
                    resolve(value);
                    cleanup();
                };

                const handleCancel = () => {
                    inputDialog.style.display = "none";
                    reject(new Error("Input cancelled by user"));
                    cleanup();
                };

                const handleKeyPress = (e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        handleSubmit();
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        handleCancel();
                    }
                };

                const cleanup = () => {
                    submitButton.removeEventListener("click", handleSubmit);
                    cancelButton.removeEventListener("click", handleCancel);
                    userInput.removeEventListener("keypress", handleKeyPress);
                };

                submitButton.addEventListener("click", handleSubmit);
                cancelButton.addEventListener("click", handleCancel);
                userInput.addEventListener("keypress", handleKeyPress);
            });
        };
    }

    function createButtonHandler(commandType, initialMessage = "") {
        return async () => {
            outputBlock.style.display = "block";
            outputBlock.textContent = initialMessage;
            inputDialog.style.display = "none";

            if (!pyodideReady) {
                const loadingMsg = language === 'python' ? "Loading Python runner..." : "Loading Jac runner...";
                outputBlock.textContent += loadingMsg + (initialMessage ? "\n" : "");
                await initPyodideWorker();
                outputBlock.textContent = outputBlock.textContent.replace(loadingMsg + (initialMessage ? "\n" : ""), "");
            }

            const outputHandler = (event) => {
                const { output, stream } = event.detail;
                outputBlock.textContent += output;
                outputBlock.scrollTop = outputBlock.scrollHeight;
            };

            document.addEventListener('jacOutputUpdate', outputHandler);

            try {
                const codeToRun = editor.getValue();
                const inputHandler = createInputHandler();
                await executeJacCodeInWorker(codeToRun, inputHandler, commandType, language);
            } catch (error) {
                outputBlock.textContent += `\nError: ${error}`;
            } finally {
                document.removeEventListener('jacOutputUpdate', outputHandler);
                inputDialog.style.display = "none";
            }
        };
    }

    runButton.addEventListener("click", createButtonHandler("run"));
    serveButton.addEventListener("click", createButtonHandler("serve", "Starting serve mode...\n"));
}

// Lazy load code blocks using Intersection Observer
const lazyObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const div = entry.target;
            if (!initializedBlocks.has(div)) {
                setupCodeBlock(div);
                initializedBlocks.add(div);
                lazyObserver.unobserve(div);
            }
        }
    });
}, {
    root: null,
    rootMargin: "0px",
    threshold: 0.1
});

// Observe all uninitialized code blocks
function observeUninitializedCodeBlocks() {
    document.querySelectorAll('.code-block').forEach((block) => {
        if (!initializedBlocks.has(block)) {
            lazyObserver.observe(block);
        }
    });
}

const domObserver = new MutationObserver(() => {
    observeUninitializedCodeBlocks();
});

domObserver.observe(document.body, {
    childList: true,
    subtree: true
});

// Initialize on DOMContentLoaded
document.addEventListener("DOMContentLoaded", async () => {
    observeUninitializedCodeBlocks();
    initPyodideWorker();

    // Watch for theme changes in Material for MkDocs
    const themeObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'data-md-color-scheme') {
                if (monacoLoaded) {
                    updateMonacoTheme();
                }
            }
        });
    });

    // Observe the body or html element for theme changes
    const targetNode = document.querySelector('[data-md-color-scheme]') || document.body;
    if (targetNode) {
        themeObserver.observe(targetNode, {
            attributes: true,
            attributeFilter: ['data-md-color-scheme']
        });
    }
});

// Add nav link mutation observer for playground links
document.addEventListener("DOMContentLoaded", function () {
    const observer = new MutationObserver(() => {
        const links = document.querySelectorAll("nav a[href='/playground/']");
        links.forEach(link => {
            link.setAttribute("target", "_blank");
            link.setAttribute("rel", "noopener");
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });
});
