interface InternalState {
    emitter: EventTarget,
    device: USBDevice,
    endpoints: {
        in: null | USBEndpoint,
        out: null | USBEndpoint,
    },
    options: {
        baudRate: number,
        stopBits: number,
        parity: number,
        dataBits: number
    },
    controller?: ReadableStreamDefaultController<Uint8Array>
}

class DriverFTDI extends EventTarget {
    private _internal: InternalState
    private active: boolean = false
    private activeReadable?: ReadableStream<Uint8Array>
    private activeWritable?: WritableStream<Uint8Array>

    constructor(device: USBDevice) {
        super()
        this._internal = {
            emitter: new EventTarget(),
            device: device,
            endpoints: {
                in: null,
                out: null
            },
            options: {
                baudRate: 9600,
                stopBits: 0,
                parity: 0,
                dataBits: 8
            }
        }
    }

    async open(options: SerialOptions) {
        this._internal.options = Object.assign(this._internal.options, options)

        /* Open the device */
        await this._internal.device.open()

        /* Claim the first interface */
        let iface = this._internal.device.configuration?.interfaces[0]
        if (!iface) throw new Error("Failed to open device")
        await this._internal.device.claimInterface(iface.interfaceNumber)

        /* Find the correct endpoints */
        iface.alternate.endpoints.forEach(endpoint => {
            if (endpoint.direction == 'in' && endpoint.type == 'bulk') {
                this._internal.endpoints.in = endpoint
            }

            if (endpoint.direction == 'out' && endpoint.type == 'bulk') {
                this._internal.endpoints.out = endpoint
            }
        })

        /* Reset device */
        await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x00,				// SIO_RESET
            value: 0x00,				// SIO_RESET_SIO
            index: iface.interfaceNumber
        }, new Uint8Array([]))

        /* Set bitmode */
        await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x0b,				// SIO_SET_BITMODE
            value: 0x00,				// BITMODE_RESET
            index: iface.interfaceNumber
        }, new Uint8Array([]))

        /* Set baudrate */
        let [value, index] = convertBaudrate(this._internal.options.baudRate, this._internal.device, iface.interfaceNumber)
        await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x03,				// SIO_SET_BAUDRATE
            value: value,
            index: index
        }, new Uint8Array([]))

        /* Set data bits, parity and stop bits */
        let config = this._internal.options.dataBits & 0x0f
        config |= this._internal.options.parity << 8
        config |= this._internal.options.stopBits << 11

        await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x04,				// SIO_SET_DATA
            value: config,
            index: iface.interfaceNumber
        }, new Uint8Array([]))

        this.active = true

        /* Poll for incoming data */
        this._poll().then(() => {
            this._internal.emitter.dispatchEvent(new Event('stopped'))
        })

        return this
    }

    async setSignals(signals: SerialOutputSignals) {
        let iface = this._internal.device.configuration?.interfaces[0]
        if (!iface) throw new Error("Failed to open device")

        let value = 0
        if (typeof signals.dataTerminalReady !== 'undefined') {
            if (signals.dataTerminalReady) value |= 0x101
            else value |= 0x100
        }
        if (typeof signals.requestToSend !== 'undefined') {
            if (signals.requestToSend) value |= 0x202
            else value |= 0x200
        }

        await this._internal.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x01, // FTDIO_SIO_MODEM_CTRL
            value,
            index: iface.interfaceNumber
        })
    }

    close() {
        return new Promise<void>((resolve) => {
            this.active = false
            this._internal.emitter.addEventListener('stopped', async () => {
                let iface = this._internal.device.configuration?.interfaces[0]
                if (iface) await this._internal.device.releaseInterface(iface.interfaceNumber)

                await this._internal.device.close()
                resolve()
            }, { once: true })

            this._internal.emitter.dispatchEvent(new Event('closing'))
        })
    }

    getInfo() {
        return {
            usbVendorId: this._internal.device.vendorId,
            usbProductId: this._internal.device.productId
        }
    }

    async _send(data: Uint8Array) {
        if (!this._internal.endpoints.out) throw new Error('Port must be open first!')

        try {
            await this._internal.device.transferOut(this._internal.endpoints.out.endpointNumber, data)
        } catch {
            this.dispatchEvent(new Event('disconnect'))
        }
    }

    async _poll() {
        if (!this._internal.endpoints.in) throw new Error('Port must be open first!')

        let closing = false
        this._internal.emitter.addEventListener('closing', () => {
            closing = true
        }, { once: true })

        while (!closing) {
            let transfer: USBInTransferResult
            try {
                transfer = await this._internal.device.transferIn(this._internal.endpoints.in.endpointNumber, 64)
            } catch (e) {
                this.dispatchEvent(new Event('disconnect'))
                break
            }

            if (transfer.status === 'ok' && transfer.data) {
                if (transfer.data.byteLength > 2) {
                    try {
                        this._internal.controller?.enqueue(new Uint8Array(transfer.data.buffer).slice(2))
                    } catch { }
                }
            }
        }
    }

    get readable() {
        if (!this.active) return
        if (this.activeReadable) return this.activeReadable

        this.activeReadable = new ReadableStream({
            start: (controller) => {
                this._internal.controller = controller
            },
            cancel: () => {
                this.activeReadable = undefined
            }
        })
        return this.activeReadable
    }

    get writable() {
        if (!this.active) return
        if (this.activeWritable) return this.activeWritable

        this.activeWritable = new WritableStream({
            write: async (chunk) => {
                await this._send(chunk)
            },
            close: () => {
                this.activeWritable = undefined
            }
        })
        return this.activeWritable
    }
}


/* Private helper functions */
function isLegacy(device: USBDevice) {
    return device.deviceVersionMajor < 2
}

function isModern(device: USBDevice) {
    return [7, 8, 9].includes(device.deviceVersionMajor)
}

function hasMPSSE(device: USBDevice) {
    return [5, 7, 8, 9].includes(device.deviceVersionMajor)
}

function convertBaudrate(baudrate: number, device: USBDevice, iface: number) {
    let BAUDRATE_REF_BASE = 3.0e6
    let BAUDRATE_REF_HIGH = 12.0e6

    /* Determine reference clock */

    let refclock, hispeed

    if (baudrate < Math.floor((2 * BAUDRATE_REF_BASE) / (2 * 16384 + 1))) throw new Error('Baudrate too low')
    if (baudrate > BAUDRATE_REF_BASE) {
        if (!isModern(device) || baudrate > BAUDRATE_REF_HIGH) throw new Error('Baudrate too high')

        refclock = BAUDRATE_REF_HIGH
        hispeed = true
    } else {
        refclock = BAUDRATE_REF_BASE
        hispeed = false
    }


    let am_adjust_up = [0, 0, 0, 1, 0, 3, 2, 1]
    let am_adjust_dn = [0, 0, 0, 1, 0, 1, 2, 3]

    let frac_code = [0, 3, 2, 4, 1, 5, 6, 7]

    let divisor = Math.floor((refclock * 8) / baudrate)
    if (isLegacy(device)) {
        divisor -= am_adjust_dn[divisor & 7]
    }

    let best_divisor = 0
    let best_baud_diff = 0


    for (let i of [0, 1]) {
        let try_divisor = divisor + i

        if (!hispeed) {

            if (try_divisor <= 8) {
                try_divisor = 8
            } else if (isLegacy(device) && try_divisor < 12) {
                try_divisor = 12
            } else if (try_divisor < 16) {
                try_divisor = 16
            } else {
                if (isLegacy(device)) {
                    try_divisor += am_adjust_up[try_divisor & 7]
                    if (try_divisor > 0x1fff8) {
                        try_divisor = 0x1fff8
                    }
                } else {
                    if (try_divisor > 0x1ffff) {
                        try_divisor = 0x1ffff
                    }
                }
            }
        }

        let baud_estimate = Math.floor(((refclock * 8) + Math.floor(try_divisor / 2)) / try_divisor)
        let baud_diff

        if (baud_estimate < baudrate)
            baud_diff = baudrate - baud_estimate
        else
            baud_diff = baud_estimate - baudrate

        if ((i == 0) || (baud_diff < best_baud_diff)) {
            best_divisor = try_divisor
            best_baud_diff = baud_diff

            if (baud_diff == 0) {
                break
            }
        }
    }


    let encoded_divisor = (best_divisor >> 3) | (frac_code[best_divisor & 7] << 14)

    if (encoded_divisor == 1)
        encoded_divisor = 0
    else if (encoded_divisor == 0x4001)
        encoded_divisor = 1

    let value = encoded_divisor & 0xFFFF
    let index

    if (hasMPSSE(device)) {
        index = (encoded_divisor >> 8) & 0xFFFF
        index &= 0xFF00
        index |= iface
    } else {
        index = (encoded_divisor >> 16) & 0xFFFF
    }

    if (hispeed) {
        index |= 1 << 9
    }

    return [value, index]
}

export default DriverFTDI
