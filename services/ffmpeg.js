const ffmpeg = require('fluent-ffmpeg');
const { EventEmitter } = require('events');
const fs = require('fs');

class FFmpegService extends EventEmitter {
  constructor() {
    super();
    this.activeStreams = new Map();
  }

  startStream(videoPath, streamUrl, streamId) {
    return new Promise((resolve, reject) => {
      // Check if file exists
      if (!fs.existsSync(videoPath)) {
        reject(new Error(`Video file not found: ${videoPath}`));
        return;
      }

      console.log('Starting stream with URL:', streamUrl);

      const command = ffmpeg()
        // Input settings
        .input(videoPath)
        .inputOptions([
          '-re',                // Read input at native frame rate
          '-stream_loop', '-1', // Loop video indefinitely
        ])
        // Video settings
        .videoCodec('libx264')
        .addOption('-preset', 'veryfast')
        .addOption('-tune', 'zerolatency')
        .addOption('-profile:v', 'main')
        .addOption('-b:v', '2500k')
        .addOption('-maxrate', '2500k')
        .addOption('-bufsize', '5000k')
        .addOption('-pix_fmt', 'yuv420p')
        .addOption('-keyint_min', '60')
        .addOption('-g', '60')
        .addOption('-r', '30')
        // Audio settings
        .audioCodec('aac')
        .addOption('-b:a', '128k')
        .addOption('-ar', '44100')
        .addOption('-ac', '2')
        // Output settings
        .format('flv')
        .output(streamUrl)
        // Event handlers
        .on('start', (commandLine) => {
          console.log('FFmpeg command:', commandLine);
          this.activeStreams.set(streamId, command);
          resolve();
        })
        .on('stderr', line => {
          console.log('FFmpeg:', line);
        })
        .on('progress', (progress) => {
          this.emit('progress', { streamId, progress });
        })
        .on('end', () => {
          console.log('Stream ended:', streamId);
          this.activeStreams.delete(streamId);
          this.emit('end', streamId);
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          this.activeStreams.delete(streamId);
          this.emit('error', { streamId, error: err });
          if (!command.ended) reject(err);
        });

      // Start streaming
      command.run();
    });
  }

  stopStream(streamId) {
    const command = this.activeStreams.get(streamId);
    if (command) {
      command.kill('SIGKILL');
      this.activeStreams.delete(streamId);
      return true;
    }
    return false;
  }

  isStreaming(streamId) {
    return this.activeStreams.has(streamId);
  }
}

module.exports = new FFmpegService(); 