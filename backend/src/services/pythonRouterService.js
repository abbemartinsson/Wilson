const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

function resolvePythonExecutable() {
  if (process.env.PYTHON_EXECUTABLE) {
    if (path.isAbsolute(process.env.PYTHON_EXECUTABLE)) {
      return fs.existsSync(process.env.PYTHON_EXECUTABLE) ? process.env.PYTHON_EXECUTABLE : null;
    }

    return process.env.PYTHON_EXECUTABLE;
  }

  const venvWindows = path.join(__dirname, '../../../.venv/Scripts/python.exe');
  const venvPosix = path.join(__dirname, '../../../.venv/bin/python');

  if (fs.existsSync(venvWindows)) {
    return venvWindows;
  }

  if (fs.existsSync(venvPosix)) {
    return venvPosix;
  }

  const versionedCandidates = ['python3.12', 'python3.11', 'python3.10', 'python3.9'];

  for (const candidate of versionedCandidates) {
    try {
      const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
      if (result && result.status === 0) {
        return candidate;
      }
    } catch (error) {
      // Continue to the next candidate.
    }
  }

  try {
    const result = spawnSync('python3', ['--version'], { stdio: 'ignore' });
    if (result && result.status === 0) {
      return 'python3';
    }
  } catch (error) {
    // Continue to the next candidate.
  }

  try {
    const result = spawnSync('python', ['--version'], { stdio: 'ignore' });
    if (result && result.status === 0) {
      return 'python';
    }
  } catch (error) {
    // Continue to the fallback.
  }

  return null;
}

function askPythonRouter(messages) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '../../python/supabase_chatbot.py');
    const pythonExecutable = resolvePythonExecutable();

    if (!pythonExecutable) {
      reject(new Error('No Python executable found. Set PYTHON_EXECUTABLE or deploy Python 3 with backend/python/requirements.txt installed.'));
      return;
    }
    const subprocessEnv = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    };

    console.log('Python router invocation:', {
      pythonExecutable,
      scriptPath,
      messageCount: Array.isArray(messages) ? messages.length : 0,
    });

    const processHandle = spawn(pythonExecutable, [scriptPath, '--chat-json'], {
      env: subprocessEnv,
    });

    let stdout = '';
    let stderr = '';

    processHandle.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    processHandle.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    processHandle.on('error', (error) => {
      reject(new Error(`Failed to start Python router: ${error.message}`));
    });

    processHandle.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python router failed (${code}): ${stderr || 'unknown error'}`));
        return;
      }

      const trimmedOutput = String(stdout || '').trim();
      if (!trimmedOutput) {
        reject(new Error('Python router returned empty response'));
        return;
      }

      try {
        const parsed = JSON.parse(trimmedOutput);
        resolve(parsed.answer || 'I could not generate a response right now.');
      } catch (error) {
        reject(new Error(`Invalid JSON from Python router: ${error.message}`));
      }
    });

    const payload = JSON.stringify({ messages });
    processHandle.stdin.write(payload);
    processHandle.stdin.end();
  });
}

module.exports = {
  askPythonRouter,
};
