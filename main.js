// Inspired by https://github.com/pbarbiero/basic-electron-react-boilerplate
// TODO: Look into https://github.com/electron-userland/electron-builder
'use strict';

// Import parts of electron to use
const { app, BrowserWindow, Menu, Tray, clipboard } = require('electron');
const path = require('path');
const url = require('url');
const process = require('process');
const MenuBuilder = require('./menu');

const AutoLaunch = require('auto-launch');

const autoLauncher = new AutoLaunch({
  name: 'Powder Web'
})

const server = require('./server')
const streams = require('./server/streams')

const btoa = require('./server/utils/btoa')

const opn = require('opn')

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;

if (app.dock)
  app.dock.hide()

// Keep a reference for dev mode
let dev = false;
if (process.env.NODE_ENV === 'development') {
  dev = true;
  require('dotenv').config({ silent: true });
}

function createWindow() {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1268,
    height: 768,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      allowpopups: true,
      webSecurity: false,
      nativeWindowOpen: true,
    },
    resizable: true,
    title: 'Powder Web',
    center: true,
    frame: false
  });

  // Disable top menu bar on Windows/Linux
  mainWindow.setMenu(null);

  // and load the index.html of the app.
  let indexPath;

  mainWindow.loadURL( 'http' + (server.isSSL ? 's': '') + '://localhost:' + server.port() + '/auth?token=' + server.masterKey );

  // Don't show until we are ready and loaded
  mainWindow.once('ready-to-show', () => {
    // Open the DevTools automatically if developing
    if (dev) {
      mainWindow.webContents.openDevTools();
    }
  });

  mainWindow.on('close', (e) => {
    e.preventDefault()
    mainWindow.hide()
    app.dock.hide()
  });

  server.setMainWindow(mainWindow)

  // Build app menu
  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
let tray = false
app.on('ready', () => {
  // Allow electron to serve static files
  if (!dev) {
    require('electron').protocol.interceptFileProtocol('file', (request, callback) => {
      const url = request.url.substr(7)    /* all urls start with 'file://' */
      callback({ path: path.normalize(`${__dirname}/dist/${url}`)})
    }, (err) => {
      if (err) console.error('Failed to register protocol')
    })
  }

  // Create the Browser window
  if (dev) {
    const {
      default: installExtension,
      REACT_DEVELOPER_TOOLS,
      REDUX_DEVTOOLS
    } = require('electron-devtools-installer');
    installExtension(REACT_DEVELOPER_TOOLS)
      .then(() => installExtension(REDUX_DEVTOOLS))
      .then(() => createWindow());
  } else {
    createWindow();
  }

  tray = new Tray(path.join(__dirname, 'packaging', 'osx_tray.png'))
  const showApp = () => {
    if (!mainWindow.isVisible()) {
      mainWindow.show()
      mainWindow.focus()
      if (!app.dock.isVisible())
        app.dock.show()
    } else {
      mainWindow.focus()
    }
  }
  const copyEmbedKey = () => {
    const servUrl = 'http' + (server.isSSL ? 's': '') + '://localhost:' + server.port() + '/'
    const embedKey = server.embedKey
    clipboard.writeText(embedKey + '-' + btoa(servUrl));
  }
  const showBrowser = () => {
    opn('http' + (server.isSSL ? 's': '') + '://localhost:' + server.port() + '/auth?token=' + server.masterKey)
  }
  const quit = () => {
    mainWindow.destroy()
    streams.closeAll(() => {
      process.exit()
    })
  }

  const toggleStartUp = () => {

     autoLauncher.isEnabled()
    .then(function(isEnabled){
      if(isEnabled){
        autoLauncher.disable()
      } else {
        autoLauncher.enable();
      }
    })
    .catch(function(err){ })

  }

  const buildContextMenu = (startUp) => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show App',
        type: 'normal',
        click: showApp
      },
      {
        label: 'Show in Browser',
        type: 'normal',
        click: showBrowser
      },
      { type: 'separator' },
      {
        label: 'Copy Embed Key',
        type: 'normal',
        click: copyEmbedKey
      },
      { type: 'separator' },
      {
        label: 'Run on Start-Up',
        type: 'checkbox',
        checked: startUp,
        click: toggleStartUp
      },
      {
        label: 'Quit',
        type: 'normal',
        click: quit
      }
    ])
    tray.setContextMenu(contextMenu)
  }

  tray.on('click', showApp)

  tray.setToolTip('Powder Web')

   autoLauncher.isEnabled()
  .then(function(isEnabled){
    buildContextMenu(isEnabled)
  }).catch(function(err){
    buildContextMenu(false)
  })
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
  }
});
