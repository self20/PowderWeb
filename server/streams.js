
const { app } = require('electron')
const createTorrent = require('./utils/torrent')
const settings = require('electron-settings')
const parser = require('./utils/parser')
const helpers = require('./utils/misc')
let addresses = require('./utils/addressbook')
let streams = {}
let shouldDestroy = {}
let canceled = {}
const path = require('path')
const pUrl = require('url')
const _ = require('lodash')
const fs = require('fs')
const os = require('os')
const ip = require('my-local-ip')
const parseTorrent = require('parse-torrent')
const organizer = require('./utils/file_organizer')
const rimraf = require('rimraf')

const openerDir = path.join(app.getPath('appData'), 'powder-streamer', 'openers')
const tempDir = path.join(os.tmpDir(), 'Powder-Streamer', 'torrent-stream')

let loading = {}

const readableSize = (fileSizeInBytes) => {
    
    if (!fileSizeInBytes) return '0.0 kB';
    
    var i = -1;
    var byteUnits = [' kB', ' MB', ' GB', ' TB', 'PB', 'EB', 'ZB', 'YB'];
    do {
        fileSizeInBytes = fileSizeInBytes / 1024;
        i++;
    } while (fileSizeInBytes > 1024);
    
    return Math.max(fileSizeInBytes, 0.1).toFixed(1) + byteUnits[i];
}

const engineExists = (utime, cb, elseCb) => {
    if (streams[utime] && streams[utime].engine)
        cb(streams[utime].engine, utime)
    else
        elseCb && elseCb()
}

const isCanceled = (utime, cb, cancelCb) => {
    if (canceled[utime] || !streams[utime])
        cancelCb && cancelCb()
    else
        cb && cb()
}

const isRedirectToMagnet = (url, cb) => {
    var http = require(url.startsWith('http:') ? 'http' : 'https');
    var parsedUrl = require('url').parse(url)

    if (parsedUrl.host.includes(':'))
        parsedUrl.host = parsedUrl.host.split(':')[0]
    var options = {method: 'GET', host: parsedUrl.host, port: parsedUrl.port, path: parsedUrl.path, headers: {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/66.0.3359.181 Safari/537.36', 'Referer': url}};
    var req = http.request(options, function(res) {
        if (!cb) return
        if (res && res.headers && res.headers.location) {
            cb && cb(res.headers.location.startsWith('magnet:'), res.headers.location)
        } else {
            cb && cb(false)
        }
        cb = false
      }
    );
    req.end();
}

const basicTorrentData = (torrent, cb) => {
    console.log('basic torrent data')
    console.log(torrent)
    if (!torrent || !torrent.startsWith) {
        cb(new Error('Unknown Error'))
        return
    }
    if (torrent.startsWith('magnet:')) {
        // magnet link
        cb(null, torrent, parseTorrent(torrent))
    } else if (torrent.startsWith('http')) {
        isRedirectToMagnet(torrent, (isMagnet, torrentUrl) => {
            if (!isMagnet) {
                // remote .torrent
                parseTorrent.remote(torrent, (err, parsed) => {
                    if (parsed && parsed.info && parsed.info.private) {
                        helpers.downloadFile(torrentUrl || torrent, function(fileLoc) {
                            cb(err, fileLoc || torrentUrl || torrent, parsed)
                        }, (parsed.infoHash || Date.now()) + '.torrent', openerDir)
                    } else {
                        cb(err, parsed ? parseTorrent.toMagnetURI(parsed) : torrent, parsed)
                    }
                })
            } else {
                basicTorrentData(torrentUrl, cb)
            }
        })
    } else if (torrent.endsWith('.torrent') && path.isAbsolute(torrent)) {
        // local .torrent
        let parsed

        try {
            parsed = parseTorrent(fs.readFileSync(torrent))
        } catch (e) { }

        if (parsed) {
            if (parsed.info && parsed.info.private) {
                cb(null, torrent, parsed)
            } else {
                cb(null, parseTorrent.toMagnetURI(parsed), parsed)
            }
        } else {
            cb(new Error('Could not read torrent file'))
        }
    } else {
        cb(new Error('Unsupported source'))
    }
}

const closeAll = (cb) => {
    if (updateInterval)
        clearInterval(updateInterval)
    updateInterval = false

    if (concurrencyInterval)
        clearInterval(concurrencyInterval)
    concurrencyInterval = false

    setTimeout(() => {
        cb && cb()
        cb = false
    }, 500)

    let ticks = _.size(streams)

    if (!ticks)
        return cb()

    _.each(streams, (el, ij) => {
        cancelTorrent(ij, () => {
            ticks--
            if (!ticks) {
                cb && cb()
            }
        }, false, true)
    })

}

let updateInterval = setInterval(() => {

    let results = []

    _.each(streams, (el, ij) => {
        if (streams[ij] && streams[ij].engine)
            results.push(torrentObj(parseInt(ij), null, streams[ij].engine))
    })

    if (results.length)
        addresses.updateList(results)

}, 1000)

const cancelTorrent = (utime, cb, force, noDelete) => {

    engineExists(utime, (engine, ij) => {

//        if (!noDelete && (force || settings.get('removeLogic') == 1)) {
        if (settings.get('removeLogic') == 1 || (!noDelete && force)) {

            addresses.remove(engine.infoHash)
            engine.kill(cb)

            const appDataTorrentFilePath = path.join(openerDir, engine.infoHash + '.torrent')

            if (fs.existsSync(appDataTorrentFilePath)) {
                fs.unlink(appDataTorrentFilePath, () => {})
            }

            const appDataMagnetLink = path.join(openerDir, engine.infoHash + '.magnet')

            if (fs.existsSync(appDataMagnetLink)) {
                fs.unlink(appDataMagnetLink, () => {})
            }

        } else if (noDelete || settings.get('removeLogic') == 2) {

            let rememberUploaded = addresses.get(engine.infoHash)
            rememberUploaded.uploadedStart = (rememberUploaded.uploadedStart || 0) + (engine.swarm && engine.swarm.uploaded ? engine.swarm.uploaded : 0)
            addresses.update(rememberUploaded)
            engine.softKill(cb)

        }

        if (streams[ij].forceInterval) {
            clearInterval(streams[ij].forceInterval)
            delete streams[ij].forceInterval
        }

        delete streams[ij]

    }, () => {
        canceled[utime] = true
        cb()
    })
}

var torrentObj = (utime, torrent, engine) => {

    let obj = {
        opener: typeof torrent === 'string' ? torrent : '',
        utime: utime || 0,
        infoHash: engine.infoHash || false,
        name: engine.torrent && engine.torrent.name ? engine.torrent.name : engine.name ? engine.name : '',
        totalSize: engine.total && engine.total.length ? engine.total.length : engine.length ? engine.length : 0,
        path: engine.path || false
    }

    if (engine.swarm) {
        obj.downloaded = engine.swarm.downloaded || 0
        obj.downloadSpeed = engine.swarm.downloadSpeed || 0
        obj.uploaded = engine.swarm.uploaded || 0
        obj.uploadSpeed = engine.swarm.uploadSpeed || 0
        obj.uploadedStart = 0
        obj.peers = engine.swarm.wires && engine.swarm.wires.length ? engine.swarm.wires.length : 0
    } else
        obj.downloaded = obj.downloadSpeed = obj.uploaded = obj.uploadSpeed = obj.uploadedStart = obj.peers = 0

    return obj

}

let checkConcurrency = () => {

    const maxConcurrency = settings.get('maxConcurrency')

    const streamsSize = _.size(streams)

    if (streamsSize > maxConcurrency) {
        let killStreams = maxConcurrency - streamsSize
        _.some(streams, (el, ij) => {
            if (!killStreams) return true
            if (streams[ij] && streams[ij].engine) {
                let engine = streams[ij].engine
                var olderThenAnHour = (Date.now() - ij > 3600000)
                if (olderThenAnHour && engine && engine.swarm && engine.swarm.wires && engine.swarm.wires.length <= 1) {
                    cancelTorrent(ij, () => {}, null, true)
                    killStreams--
                }
            }
        })
    }

}

// make sure concurrency is kept every 30 minutes
let concurrencyInterval = setInterval(checkConcurrency, 1800000)

const actions = {

    closeAll: closeAll,

    speedUp: (torrentId) => {

        _.each(streams, (el, ij) => {
            if (ij != torrentId && streams[ij] && streams[ij].engine) {
                let engine = streams[ij].engine
                cancelTorrent(ij, () => {}, null, true)
            }
        })

    },

    deleteAllPaused: () => {
        let allTorrents = addresses.getAll(streams)

        _.each(allTorrents, (el, ij) => {
            if (!el.running) {
                if (el.path)
                    rimraf(el.path, () => {})
                addresses.remove(el.infoHash)
            }
        })
    },

    new: (torrent, idCb, readyCb, listeningCb, errCb, resume) => {

        if (resume && torrent && torrent.length == 40) {
            // get opener from fs
            const appDataTorrentFilePath = path.join(openerDir, torrent + '.torrent')

            if (fs.existsSync(appDataTorrentFilePath)) {
                torrent = appDataTorrentFilePath
            } else {

                const appDataMagnetLink = path.join(openerDir, torrent + '.magnet')

                if (fs.existsSync(appDataMagnetLink)) {
                    torrent = fs.readFileSync(appDataMagnetLink)
                } else {
                    torrent = addresses.get(torrent).opener
                }

            }
        }

        basicTorrentData(torrent, (err, newOpener, torrentData) => {

            if (err) {
                errCb && errCb(err)
                return
            }

            if (newOpener)
                torrent = newOpener

            // save magnet opener
            const magnetPath = path.join(openerDir, torrentData.infoHash+'.magnet')

            if (!fs.existsSync(magnetPath)) {

                fs.writeFile(magnetPath, torrent, function(err) {
                    if (err) {
                        return console.log(err);
                    }
                })

            }

            const utime = Date.now()

            // keep these 2 as separate object responses because the object gets morphed in addresses.add()

            var added = addresses.add(torrentObj(utime, torrent, torrentData))

            if (!added && !resume) {
                errCb(new Error('Torrent already exists'))
                return
            } else {
                let streamerId
                const foundStreamer = _.some(streams, (el, ij) => {
                    if (el.engine && el.engine.infoHash == torrentData.infoHash) {
                        streamerId = ij
                        return true
                    }
                })
                if (foundStreamer) {
                    const streamer = streams[streamerId]
                    idCb(torrentObj(streamerId, torrent, torrentData))
                    readyCb && readyCb(streamer.engine, streamer.organizedFiles)
                    listeningCb && listeningCb(streamer.engine, streamer.organizedFiles)
                    return
                } else {
                    idCb(torrentObj(utime, torrent, torrentData))
                }
            }

            canceled[utime] = false
            streams[utime] = {}

            checkConcurrency()

            const remover = () => {
                addresses.remove(torrentData.infoHash)
                delete canceled[utime]
                if (streams[utime]) {
                    if (streams[utime].forceInterval) {
                        clearInterval(streams[utime].forceInterval)
                        delete streams[utime].forceInterval
                    }
                    delete streams[utime]
                }
            }

            const fail = (err) => {
                if (err && err.message)
                    errCb(err)
                else
                    errCb(new Error('Unknown error occured'))
            }

            createTorrent(torrent).then((result) => {

                let worker = result.worker
                let engine = result.engine

                streams[utime].worker = worker

                let filesOrganized = false
                let delayListening = false

                engine.on('listening', () => {

                    // save torrent file for this torrent
                    const torrentFilePath = path.join(tempDir, torrentData.infoHash + '.torrent')
                    const appDataTorrentFilePath = path.join(openerDir, torrentData.infoHash + '.torrent')

                    if (fs.existsSync(torrentFilePath) && !fs.existsSync(appDataTorrentFilePath)) {
                        fs.createReadStream(torrentFilePath).pipe(fs.createWriteStream(appDataTorrentFilePath))
                    }

                    isCanceled(utime, () => {
                        streams[utime].amListening = true
                        streams[utime].engine.streamPort = engine.server.address().port
                        if (!filesOrganized) {
                            delayListening = true
                        } else {
                            listeningCb && listeningCb(engine, streams[utime].organizedFiles)
                        }
                    }, () => {
                        remover()
                    })
                })

                engine.on('ready', () => {
                    isCanceled(utime, () => {
                        delete canceled[utime]
                        let newAddress = torrentObj(utime, torrent, engine)
                        const address = addresses.get(newAddress.infoHash)
                        if (address) {
                            if (address.pulsing) {
                                newAddress.pulsing = address.pulsing
                                actions.setPulse(utime, address.pulsing)
                            }
                            if (address.forced) {
                                newAddress.forced = address.forced
                                actions.forceDownload(utime, address.forced)
                            }
                        } else {
                            if (settings.get('speedLimit')) {
                                newAddress.pulsing = settings.get('speedLimit')
                                actions.setPulse(utime, newAddress.pulsing)
                            }
                            if (settings.get('forceDownload')) {
                                newAddress.forced = settings.get('forceDownload')
                                actions.forceDownload(utime, newAddress.forced)
                            }
                        }
                        addresses.update(newAddress)
                        streams[utime].engine = engine
                        organizer(engine).then(files => {
                            filesOrganized = true
                            streams[utime].organizedFiles = files
                            readyCb && readyCb(engine, files)
                            if (delayListening) {
                                listeningCb && listeningCb(engine, files)
                            }
                        }).catch(fail)
                    }, () => {
                        worker.peerSocket.emit('engineDestroy')
                        remover()
                    })
                })
            }).catch(fail)

        })

    },

    cancel: cancelTorrent,

    cancelByInfohash(infohash, cb, force, noDelete) {

        let streamerId
        const foundStreamer = _.some(streams, (el, ij) => {
            if (el.engine && el.engine.infoHash == infohash) {
                streamerId = ij
                return true
            }
        })

        if (foundStreamer) {
            cancelTorrent(streamerId, cb, force, noDelete)
        } else {
            const torrentData = addresses.get(infohash)
            if (torrentData) {

                if (torrentData.path) {
                    rimraf(torrentData.path, () => {})
                }

                addresses.remove(torrentData.infoHash)
            }
        }

    },

    getPortFor(infohash) {
        let streamerId
        const foundStreamer = _.some(streams, (el, ij) => {
            if (el.engine && el.engine.infoHash == infohash) {
                streamerId = ij
                return true
            }
        })
        if (foundStreamer) {
            return streams[streamerId].engine.streamPort
        } else {
            return 0
        }
    },

    isListening(utime) {
        return streams[utime].amListening || false
    },

    getEngine(utime) {
        return streams[utime] ? streams[utime].engine : false
    },

    getOrganizedFiles(utime) {
        return streams[utime] ? streams[utime].organizedFiles : false
    },

    getUtime(infoHash) {
        let foundUtime = false
        _.some(streams, (el, ij) => {
            if (el.engine && el.engine.infoHash == infoHash) {
                foundUtime = ij
                return true
            }
        })
        return foundUtime
    },

    getUpdate(utime) {
        if (utime) {
            if (streams[utime] && streams[utime].engine && streams[utime].engine.infoHash) {
                return addresses.get(streams[utime].engine.infoHash)
            } else {
                return false
            }
        } else {
            let results = []
            _.each(streams, el => {
                if (el && el.engine && el.engine.infoHash) {
                    results.push(el.engine.infoHash)
                }
            })
            return addresses.getList(results)
        }
    },

    setPulse(utime, pulse, cb) {
        engineExists(utime, engine => {
            if (!pulse) {
                engine.flood()
                let address = addresses.get(engine.infoHash)
                address.pulsing = false
                addresses.update(address)
            } else {
                actions.forceDownload(utime, false, () => {
                    engine.setPulse(pulse *1000)
                    let address = addresses.get(engine.infoHash)
                    address.pulsing = pulse
                    address.forced = false
                    addresses.update(address)
                })
            }
            cb && cb()
        })
    },

    isForced(utime, cb) {
        engineExists(utime, engine => {
            const address = addresses.get(engine.infoHash)
            cb(address && address.forced ? true : false)
        }, () => {
            cb(false)
        })
    },

    forceDownload(utime, should, cb) {
        engineExists(utime, engine => {
            if (should) {
                actions.setPulse(utime, false, () => {
                    engine.discover()
                    let address = addresses.get(engine.infoHash)
                    address.forced = true
                    address.pulsing = false
                    addresses.update(address)
                    const forceInterval = setInterval(() => {
                        engineExists(utime, engine => {
                            const progress = engine.torrent.pieces.downloaded / engine.torrent.pieces.length;
                            if (progress < 1)
                                engine.discover()
                            else {
                                clearInterval(forceInterval)
                                delete streams[utime].forceInterval
                            }
                            cb && cb()
                        }, () => {
                            clearInterval(forceInterval)
                            delete streams[utime].forceInterval
                            cb && cb()
                        })
                    }, 120000) // 2 minutes
                    streams[utime].forceInterval = forceInterval
                })
            } else {
                if (streams[utime].forceInterval) {
                    clearInterval(streams[utime].forceInterval)
                    delete streams[utime].forceInterval
                    let address = addresses.get(engine.infoHash)
                    address.forced = false
                    addresses.update(address)
                }
                cb && cb()
            }
        })
    },

    toggleStateFile(infohash, fileId) {
        let streamerId
        const foundStreamer = _.some(streams, (el, ij) => {
            if (el.engine && el.engine.infoHash == infohash) {
                streamerId = ij
                return true
            }
        })
        if (foundStreamer) {
            const streamer = streams[streamerId]
            const engine = streamer.engine
            if (engine.files && engine.files.length) {
                const file = streamer.engine.files[fileId]
                if (file) {
                    if (file.selected) {
                        engine.deselectFile(fileId)
                    } else {
                        engine.selectFile(fileId)
                    }
                }
            }
        }
    },

    createPlaylist(utime, files, token, fileId, cb, requestHost) {


        const engine = streams[utime].engine
        const enginePort = engine.streamPort || engine.server.port || engine.server.address().port

        let newM3U = "#EXTM3U";

        const altHost = 'http://' + ip() + ':' + enginePort

        files.ordered.some((file) => {
            if (fileId !== false) {
                if (file.id == fileId) {
                    const title = parser(file.name).name()
                    const uri = (requestHost || altHost) + '/api/' + engine.infoHash + '/' + file.name + '?token='+token
                    newM3U += os.EOL+"#EXTINF:0,"+title+os.EOL+uri
                    return true
                }
            } else {
                const title = parser(file.name).name()
                const uri = (requestHost || altHost) + '/api/' + engine.infoHash + '/' + file.name + '?token='+token
                newM3U += os.EOL+"#EXTINF:0,"+title+os.EOL+uri
            }
        })

        cb(newM3U)

    },

    getAll() {
        return addresses.getAll(streams)
    },

    haveTorrent(infoHash) {
        return addresses.get(infoHash)
    },

    torrentData(infohash, cb, defaultFiles) {
        let streamerId
        const foundStreamer = _.some(streams, (el, ij) => {
            if (el.engine && el.engine.infoHash == infohash) {
                streamerId = ij
                return true
            }
        })
        if (foundStreamer) {
            const streamer = streams[streamerId]
            const engine = streamer.engine
            const address = addresses.get(engine.infoHash)
            const isFinished = (engine.torrent.pieces.length == engine.torrent.pieces.downloaded)
            const orderedFiles = streamer.organizedFiles && streamer.organizedFiles.ordered ? streamer.organizedFiles.ordered : false
            cb({
                name: engine.torrent.name,
                infoHash: engine.infoHash,
                swarm: engine.swarm,
                total: engine.total,
                isFinished,
                opener: address.opener || '',
                uploadStart: address.uploadedStart || 0,
                files: defaultFiles ? engine.files : (orderedFiles || engine.files).map(el => {
                    const file = engine.files[el.id || el.fileID]
                    el.progress = isFinished ? 100 : Math.round(engine.torrent.pieces.bank.filePercent(file.offset, file.length) * 100)
                    if (el.progress > 100)
                        el.progress = 100
                    el.downloaded = isFinished ? file.length : readableSize(Math.round(file.length * el.progress))
                    el.selected = file.selected
                    return el
                }),
                path: defaultFiles ? engine.path : false
            }, defaultFiles ? engine.torrent.pieces.bank : null)
        } else if (!loading[infohash]) {
            loading[infohash] = true

            actions.new(infohash,

                torrentObj => {

                },

                (engine, organizedFiles) => {

                },

                (engine, organizedFiles) => {

                    delete loading[infohash]

                    actions.torrentData(infohash, cb, defaultFiles)

                },

                (err) => {

                    delete loading[infohash]

                    cb(false)

                }, true)

        } else
            cb(false)
    },

    getFilePath(infohash, fileID, cb) {
        let streamerId
        const foundStreamer = _.some(streams, (el, ij) => {
            if (el.engine && el.engine.infoHash == infohash) {
                streamerId = ij
                return true
            }
        })
        if (foundStreamer) {
            const engine = streams[streamerId].engine
            let filePath = false
            _.some(engine.files, (file) => {
                if (file.fileID == fileID) {
                    filePath = path.join(engine.path, file.path)
                    return true
                }
            })
            cb(filePath)
        } else {
            cb(false)
        }
    },

    getPath(infohash, cb) {
        const address = addresses.get(infohash)
        if (address && address.path) {
            cb(address.path)
        } else {
            cb(false)
        }
    },

    getTorrentId(infohash) {
        let thisTorrentId = false

        _.some(streams, (el, ij) => {
            if (el.engine && el.engine.infoHash == infohash) {
                thisTorrentId = ij
                return true
            }
        })

        return thisTorrentId
    }
}

module.exports = actions
