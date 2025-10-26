let pyodide = null;

// Functions to load Pyodide and its jaclang
async function readFileAsBytes(fileName) {
  const response = await fetch(fileName);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

async function loadPythonResources(pyodide) {
  try {
    const data = await readFileAsBytes("../playground/jaclang.zip");
    await pyodide.FS.writeFile("/jaclang.zip", data);
    await pyodide.runPythonAsync(`
import zipfile
import os

try:
    with zipfile.ZipFile("/jaclang.zip", "r") as zip_ref:
        zip_ref.extractall("/jaclang")
    os.sys.path.append("/jaclang")
    print("JacLang files loaded!")
except Exception as e:
    print("Failed to extract JacLang files:", e)
    raise
`);
  } catch (err) {
    console.error("Error loading Python resources:", err);
    throw err;
  }
}

// Worker code
self.onmessage = async (event) => {
    const { type, code, value, sab, language } = event.data;

    if (type === "init") {
        sabRef = sab;
        self.shared_buf = sabRef;

        importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.js");
        pyodide = await loadPyodide();
        await loadPythonResources(pyodide);
        await pyodide.runPythonAsync(`
from jaclang.cli.cli import run, serve
from js import postMessage, Atomics, Int32Array, Uint8Array, shared_buf
import builtins
import sys

ctrl = Int32Array.new(shared_buf)
data = Uint8Array.new(shared_buf, 8)
FLAG, LEN = 0, 1

# Custom output handler for real-time streaming
class StreamingOutput:
    def __init__(self, stream_type="stdout"):
        self.stream_type = stream_type

    def write(self, text):
        if text:
            import json
            message = json.dumps({
                "type": "streaming_output",
                "output": text,
                "stream": self.stream_type
            })
            postMessage(message)
        return len(text)

    def flush(self):
        pass

    def isatty(self):
        # Always return False for web playground to disable colors
        # This prevents messy ANSI color codes in the output
        return False

def pyodide_input(prompt=""):
    prompt_str = str(prompt)

    import json
    message = json.dumps({"type": "input_request", "prompt": prompt_str})
    postMessage(message)

    Atomics.wait(ctrl, FLAG, 0)

    n = ctrl[LEN]
    b = bytes(data.subarray(0, n).to_py())
    s = b.decode("utf-8", errors="replace")

    Atomics.store(ctrl, FLAG, 0)
    return s

builtins.input = pyodide_input
        `);
        self.postMessage({ type: "ready" });
        return;
    }

    if (!pyodide) {
        return;
    }

    try {
        const codeStr = JSON.stringify(code);
        const cliCommand = type === "serve" ? "serve" : "run";
        const lang = language || "jac";

        if (lang === "python") {
            // Run Python code directly
            const output = await pyodide.runPythonAsync(`
import sys

# Set up streaming output
streaming_stdout = StreamingOutput("stdout")
streaming_stderr = StreamingOutput("stderr")
original_stdout = sys.stdout
original_stderr = sys.stderr

sys.stdout = streaming_stdout
sys.stderr = streaming_stderr

python_code = ${codeStr}

try:
    exec(python_code)
except SystemExit:
    # The Jac compiler may call SystemExit on fatal errors (e.g., syntax errors).
    # Detailed error reports are already emitted to stderr by the parser,
    # so we suppress the exit here to avoid re-raising or duplicating messages.
    pass
except Exception as e:
    import traceback
    print(traceback.format_exc(), file=sys.stderr)

# Restore original streams
sys.stdout = original_stdout
sys.stderr = original_stderr
            `);
        } else {
            // Run Jac code through CLI
            const output = await pyodide.runPythonAsync(`
from jaclang.cli.cli import run, serve
import sys

# Set up streaming output
streaming_stdout = StreamingOutput("stdout")
streaming_stderr = StreamingOutput("stderr")
original_stdout = sys.stdout
original_stderr = sys.stderr

sys.stdout = streaming_stdout
sys.stderr = streaming_stderr

jac_code = ${codeStr}
with open("/tmp/temp.jac", "w") as f:
    f.write(jac_code)

try:
    if "${cliCommand}" == "serve":
        serve("/tmp/temp.jac", faux=True)
    else:
        run("/tmp/temp.jac")
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)

# Restore original streams
sys.stdout = original_stdout
sys.stderr = original_stderr
            `);
        }
        self.postMessage({ type: "execution_complete" });
    } catch (error) {
        self.postMessage({ type: "error", error: error.toString() });
    }
};
