import { app, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let daemonProcess = null;

// Determine if we are in development mode
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function startDaemon() {
  const daemonPath = path.join(__dirname, '../daemon/index.js');
  const appDataPath = app.getPath('userData');
  
  const env = {
    ...process.env,
    PORT: '22001',
    WS_PORT: '9001',
    HTTP_PORT: '8001',
    DB_PATH: path.join(appDataPath, 'node_db.json'),
    DOWNLOADS_DIR: path.join(appDataPath, 'downloads'),
    RELAY_URL: process.env.RELAY_URL || 'wss://call-of-ssh-relay.onrender.com',
    ALIAS: process.env.ALIAS || 'Alice'
  };

  console.log(`[Electron] Starting background daemon at: ${daemonPath}`);
  console.log(`[Electron] Persistent DB Path: ${env.DB_PATH}`);
  
  daemonProcess = spawn('node', [daemonPath], { env });

  daemonProcess.stdout.on('data', (data) => {
    console.log(`[Daemon STDOUT]: ${data.toString().trim()}`);
  });

  daemonProcess.stderr.on('data', (data) => {
    console.error(`[Daemon STDERR]: ${data.toString().trim()}`);
  });

  daemonProcess.on('close', (code) => {
    console.log(`[Electron] Daemon process exited with code ${code}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 400,
    minHeight: 500,
    title: 'Call of SSH | P2P Secure Messenger',
    backgroundColor: '#0a0b0e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false // Required to load local media http links from file:// UI origin
    }
  });

  if (isDev) {
    // Load Vite local development server
    mainWindow.loadURL('http://localhost:3001');
    mainWindow.webContents.openDevTools();
  } else {
    // Load compiled static frontend build files
    const htmlPath = path.join(__dirname, '../frontend/dist/index.html');
    mainWindow.loadFile(htmlPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startDaemon();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (daemonProcess) {
    console.log('[Electron] Terminating background daemon process...');
    daemonProcess.kill();
  }
});
