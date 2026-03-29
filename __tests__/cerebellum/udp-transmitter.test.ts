import * as dgram from 'dgram';
import { UDPTransmitter } from '../../src/2_qwen_cerebellum/udp_transmitter';
import {
  encodeFrame, encodeFrameV2, decodeFrameV2, Opcode, FRAME_SIZE, FRAME_SIZE_V2,
  ACK_FLAG, ACK_OPCODE,
} from '../../src/2_qwen_cerebellum/bytecode_compiler';

describe('UDPTransmitter', () => {
  let transmitter: UDPTransmitter;
  let mockServer: dgram.Socket;
  let serverPort: number;

  beforeEach((done) => {
    // Create a mock UDP server to receive frames
    mockServer = dgram.createSocket('udp4');
    mockServer.bind(0, '127.0.0.1', () => {
      const addr = mockServer.address();
      serverPort = addr.port;
      transmitter = new UDPTransmitter({
        host: '127.0.0.1',
        port: serverPort,
        timeoutMs: 500,
        maxRetries: 1,
      });
      done();
    });
  });

  afterEach(async () => {
    await transmitter.disconnect();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  // ===========================================================================
  // Connection
  // ===========================================================================

  test('connect creates UDP socket', async () => {
    await transmitter.connect();
    expect(transmitter.isConnected()).toBe(true);
  });

  test('disconnect closes socket', async () => {
    await transmitter.connect();
    await transmitter.disconnect();
    expect(transmitter.isConnected()).toBe(false);
  });

  test('double connect is idempotent', async () => {
    await transmitter.connect();
    await transmitter.connect(); // should not throw
    expect(transmitter.isConnected()).toBe(true);
  });

  test('disconnect when not connected is safe', async () => {
    await transmitter.disconnect(); // should not throw
    expect(transmitter.isConnected()).toBe(false);
  });

  // ===========================================================================
  // Sending frames
  // ===========================================================================

  test('sends 6-byte frame to server', async () => {
    await transmitter.connect();

    const received = new Promise<Buffer>((resolve) => {
      mockServer.on('message', (msg) => resolve(msg));
    });

    const frame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
    await transmitter.send(frame);

    const msg = await received;
    expect(msg.length).toBe(FRAME_SIZE);
    expect(msg[0]).toBe(0xAA);
    expect(msg[1]).toBe(Opcode.STOP);
    expect(msg[5]).toBe(0xFF);
  });

  test('sends MOVE_FORWARD frame', async () => {
    await transmitter.connect();

    const received = new Promise<Buffer>((resolve) => {
      mockServer.on('message', (msg) => resolve(msg));
    });

    const frame = encodeFrame({ opcode: Opcode.MOVE_FORWARD, paramLeft: 100, paramRight: 100 });
    await transmitter.send(frame);

    const msg = await received;
    expect(msg[1]).toBe(Opcode.MOVE_FORWARD);
    expect(msg[2]).toBe(100);
    expect(msg[3]).toBe(100);
  });

  test('rejects frame with wrong size', async () => {
    await transmitter.connect();
    await expect(transmitter.send(Buffer.from([0xAA, 0x01]))).rejects.toThrow('Invalid frame size');
  });

  test('rejects when not connected', async () => {
    const frame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
    await expect(transmitter.send(frame)).rejects.toThrow('not connected');
  });

  // ===========================================================================
  // Stats
  // ===========================================================================

  test('tracks send stats', async () => {
    await transmitter.connect();

    const frame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
    await transmitter.send(frame);
    await transmitter.send(frame);

    const stats = transmitter.getStats();
    expect(stats.framesSent).toBe(2);
    expect(stats.bytesTransmitted).toBe(12); // 6 * 2
    expect(stats.errors).toBe(0);
    expect(stats.connected).toBe(true);
  });

  // ===========================================================================
  // sendAndReceive
  // ===========================================================================

  test('sendAndReceive gets response', async () => {
    await transmitter.connect();

    // Mock server echoes back
    mockServer.on('message', (msg, rinfo) => {
      mockServer.send(Buffer.from('{"ok":true}'), rinfo.port, rinfo.address);
    });

    const frame = encodeFrame({ opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 });
    const response = await transmitter.sendAndReceive(frame);

    expect(response.toString()).toBe('{"ok":true}');
  });

  test('sendAndReceive times out', async () => {
    await transmitter.connect();

    // Server doesn't respond
    const frame = encodeFrame({ opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 });
    await expect(transmitter.sendAndReceive(frame, 100)).rejects.toThrow('timeout');
  });

  // ===========================================================================
  // Sequence number & dropped frames
  // ===========================================================================

  test('tracks sequence number across sends', async () => {
    await transmitter.connect();

    const frame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
    await transmitter.send(frame);
    await transmitter.send(frame);
    await transmitter.send(frame);

    const stats = transmitter.getStats();
    expect(stats.currentSequence).toBe(3);
  });

  test('increments droppedFrames on sendAndReceive timeout', async () => {
    await transmitter.connect();

    const frame = encodeFrame({ opcode: Opcode.GET_STATUS, paramLeft: 0, paramRight: 0 });

    // First timeout
    await expect(transmitter.sendAndReceive(frame, 50)).rejects.toThrow('timeout');
    // Second timeout
    await expect(transmitter.sendAndReceive(frame, 50)).rejects.toThrow('timeout');

    const stats = transmitter.getStats();
    expect(stats.droppedFrames).toBe(2);
  });

  test('initial stats have zero sequence and dropped frames', async () => {
    const stats = transmitter.getStats();
    expect(stats.currentSequence).toBe(0);
    expect(stats.droppedFrames).toBe(0);
  });

  // ===========================================================================
  // V2 Protocol — send and sendWithAck
  // ===========================================================================

  test('send accepts 8-byte V2 frames', async () => {
    await transmitter.connect();

    const received = new Promise<Buffer>((resolve) => {
      mockServer.on('message', (msg) => resolve(msg));
    });

    const frame = encodeFrameV2({
      opcode: Opcode.MOVE_FORWARD, paramLeft: 100, paramRight: 100,
      sequenceNumber: 1, flags: 0,
    });
    await transmitter.send(frame);

    const msg = await received;
    expect(msg.length).toBe(FRAME_SIZE_V2);
    expect(msg[0]).toBe(0xAA);
    expect(msg[2]).toBe(Opcode.MOVE_FORWARD);
  });

  test('sendWithAck resolves when ACK received', async () => {
    await transmitter.connect();

    // Mock server sends ACK for matching seq
    mockServer.on('message', (msg, rinfo) => {
      const decoded = decodeFrameV2(msg);
      if (decoded && (decoded.flags & ACK_FLAG)) {
        const ackFrame = encodeFrameV2({
          opcode: ACK_OPCODE, paramLeft: 0, paramRight: 0,
          sequenceNumber: decoded.sequenceNumber, flags: 0,
        });
        mockServer.send(ackFrame, rinfo.port, rinfo.address);
      }
    });

    await transmitter.sendWithAck({
      opcode: Opcode.MOVE_FORWARD, paramLeft: 128, paramRight: 128,
      sequenceNumber: 5, flags: 0,
    });

    const stats = transmitter.getStats();
    expect(stats.framesSent).toBe(1);
  });

  test('sendWithAck times out when no ACK received', async () => {
    const fastTransmitter = new UDPTransmitter({
      host: '127.0.0.1', port: serverPort, ackTimeoutMs: 50,
    });
    await fastTransmitter.connect();

    // Server does NOT respond with ACK
    await expect(fastTransmitter.sendWithAck({
      opcode: Opcode.STOP, paramLeft: 0, paramRight: 0,
      sequenceNumber: 1, flags: 0,
    })).rejects.toThrow('ACK timeout');

    const stats = fastTransmitter.getStats();
    expect(stats.droppedFrames).toBe(1);

    await fastTransmitter.disconnect();
  });

  // ===========================================================================
  // onMessage callback
  // ===========================================================================

  test('onMessage receives data sent to the transmitter socket', async () => {
    await transmitter.connect();

    const received = new Promise<string>((resolve) => {
      transmitter.onMessage((msg) => {
        resolve(msg.toString());
      });
    });

    // Send a message from the mock server to the transmitter's socket
    // First, we need the transmitter to send something so the server knows the port
    const frame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });

    const clientPort = await new Promise<number>((resolve) => {
      mockServer.on('message', (_msg, rinfo) => {
        resolve(rinfo.port);
      });
      transmitter.send(frame);
    });

    // Now send telemetry-like data back to the transmitter
    const telemetry = JSON.stringify({ telemetry: true, pose: { x: 1, y: 2, h: 0.5 }, vel: { left: 0, right: 0 }, stall: false, ts: 1234 });
    mockServer.send(Buffer.from(telemetry), clientPort, '127.0.0.1');

    const data = await received;
    expect(JSON.parse(data)).toMatchObject({ telemetry: true, pose: { x: 1, y: 2 } });
  });

  test('onMessage registered before connect is applied after connect', async () => {
    // Create a fresh transmitter (not yet connected)
    const freshTransmitter = new UDPTransmitter({
      host: '127.0.0.1', port: serverPort,
    });

    const received = new Promise<string>((resolve) => {
      // Register before connect
      freshTransmitter.onMessage((msg) => {
        resolve(msg.toString());
      });
    });

    await freshTransmitter.connect();

    // Send a frame so we know the port
    const frame = encodeFrame({ opcode: Opcode.STOP, paramLeft: 0, paramRight: 0 });
    const clientPort = await new Promise<number>((resolve) => {
      const handler = (_msg: Buffer, rinfo: dgram.RemoteInfo) => {
        mockServer.removeListener('message', handler);
        resolve(rinfo.port);
      };
      mockServer.on('message', handler);
      freshTransmitter.send(frame);
    });

    // Send data back
    mockServer.send(Buffer.from('{"hello":true}'), clientPort, '127.0.0.1');

    const data = await received;
    expect(JSON.parse(data)).toMatchObject({ hello: true });

    await freshTransmitter.disconnect();
  });

  test('sendWithAck ignores ACK with wrong sequence number', async () => {
    const fastTransmitter = new UDPTransmitter({
      host: '127.0.0.1', port: serverPort, ackTimeoutMs: 100,
    });
    await fastTransmitter.connect();

    // Server sends ACK with wrong seq
    mockServer.on('message', (msg, rinfo) => {
      const ackFrame = encodeFrameV2({
        opcode: ACK_OPCODE, paramLeft: 0, paramRight: 0,
        sequenceNumber: 99, // wrong seq
        flags: 0,
      });
      mockServer.send(ackFrame, rinfo.port, rinfo.address);
    });

    await expect(fastTransmitter.sendWithAck({
      opcode: Opcode.STOP, paramLeft: 0, paramRight: 0,
      sequenceNumber: 1, flags: 0,
    })).rejects.toThrow('ACK timeout');

    await fastTransmitter.disconnect();
  });
});
