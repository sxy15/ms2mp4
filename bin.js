#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const CONFIG = require('./config');

// 全局状态
const STATUS = {
    total: 0,
    completed: 0,
    inProgress: new Map(),
    results: new Map(),
    durations: {}
};

// 打印进度
function printProgress() {
    // 清除控制台
    process.stdout.write('\x1B[2J\x1B[0f');
    
    // 显示总进度
    const percent = ((STATUS.completed / STATUS.total) * 100).toFixed(1);
    console.log(`总体进度: ${STATUS.completed}/${STATUS.total} (${percent}%)\n`);
    
    // 显示正在处理的文件
    if (STATUS.inProgress.size > 0) {
        console.log('正在处理:');
        STATUS.inProgress.forEach((progress, file) => {
            console.log(`→ ${file} (${progress}%)`);
        });
    }

    // 显示最近完成的文件
    const recentResults = Array.from(STATUS.results.entries()).slice(-5);
    if (recentResults.length > 0) {
        console.log('\n最近完成:');
        recentResults.forEach(([file, success]) => {
            const symbol = success ? '✓' : '✗';
            console.log(`${symbol} ${file}`);
        });
    }
}

// 处理单个视频
async function processVideo(videoPath, subtitlePath, outputPath) {
  const filename = path.basename(videoPath);
  
  return new Promise((resolve, reject) => {
      STATUS.inProgress.set(filename, 0);
      printProgress();

      const encoder = CONFIG.encoding.getEncoder();
      const ffmpegArgs = [
          '-hwaccel', 'auto',
          '-i', videoPath,
          '-vf', `subtitles=${subtitlePath}:force_style='${CONFIG.subtitleStyle}'`,
          '-c:v', encoder,
          '-preset', CONFIG.encoding.preset,
          '-crf', CONFIG.encoding.crf,
          '-threads', CONFIG.encoding.threads,
          '-c:a', 'copy',
          '-maxrate', '1.5M',
          '-bufsize', '3M',
          '-tune', 'fastdecode',
          '-movflags', '+faststart',
          '-max_muxing_queue_size', '1024',
          '-y',
          outputPath
      ];

      console.log(`开始处理: ${filename}`);
      console.log('FFmpeg 命令:', 'ffmpeg', ffmpegArgs.join(' '));

      const ffmpeg = spawn('ffmpeg', ffmpegArgs);
      let duration = 0;
      let lastProgress = 0;

      ffmpeg.stderr.on('data', (data) => {
          const output = data.toString();

          // 获取视频时长（只在开始时获取一次）
          if (!duration) {
              const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}.\d{2})/);
              if (durationMatch) {
                  const [_, hours, minutes, seconds] = durationMatch;
                  duration = (parseFloat(hours) * 3600 +
                            parseFloat(minutes) * 60 +
                            parseFloat(seconds));
                  console.log(`视频时长: ${duration} 秒`);
              }
          }

          // 获取当前处理时间
          const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2}.\d{2})/);
          if (timeMatch && duration > 0) {
              const [_, hours, minutes, seconds] = timeMatch;
              const currentTime = (parseFloat(hours) * 3600 +
                                 parseFloat(minutes) * 60 +
                                 parseFloat(seconds));
              
              const progress = ((currentTime / duration) * 100).toFixed(1);
              
              // 只有当进度变化超过0.1%时才更新
              if (Math.abs(progress - lastProgress) >= 0.1) {
                  lastProgress = parseFloat(progress);
                  STATUS.inProgress.set(filename, progress);
                  printProgress();
              }
          }
      });

      ffmpeg.on('close', (code) => {
          STATUS.inProgress.delete(filename);
          STATUS.completed++;
          STATUS.results.set(filename, code === 0);
          printProgress();

          if (code === 0) {
              console.log(`成功完成: ${filename}`);
              resolve(`成功处理: ${filename}`);
          } else {
              console.log(`处理失败: ${filename}`);
              reject(new Error(`处理失败 ${filename}`));
          }
      });

      ffmpeg.on('error', (err) => {
          console.error(`处理错误: ${filename}`, err);
          STATUS.inProgress.delete(filename);
          STATUS.completed++;
          STATUS.results.set(filename, false);
          printProgress();
          reject(new Error(`FFmpeg 错误: ${err.message}`));
      });
  });
}

// 查找匹配的文件
async function findMatchingFiles(inputDir) {
    const files = await fs.readdir(inputDir);
    const videos = new Map();
    const subtitles = new Map();

    files.forEach(file => {
        const filePath = path.join(inputDir, file);
        const ext = path.extname(file).toLowerCase();
        const nameWithoutExt = path.parse(file).name.toLowerCase()
            .replace(/[\s\-_\[\]()]/g, '');

        if (CONFIG.videoExtensions.includes(ext)) {
            videos.set(nameWithoutExt, filePath);
        } else if (CONFIG.subtitleExtensions.includes(ext)) {
            subtitles.set(nameWithoutExt, filePath);
        }
    });

    const matches = [];
    for (const [name, videoPath] of videos) {
        if (subtitles.has(name)) {
            matches.push({
                video: videoPath,
                subtitle: subtitles.get(name)
            });
        }
    }

    return matches;
}

// 批量处理文件
async function processBatch(matches, outputDir, startIndex, endIndex) {
    const tasks = matches.slice(startIndex, endIndex).map(async match => {
        const outputFile = path.join(
            outputDir,
            `${path.parse(match.video).name}_output.mp4`
        );

        try {
            await processVideo(match.video, match.subtitle, outputFile);
            return { success: true, file: path.basename(match.video) };
        } catch (error) {
            return { success: false, file: path.basename(match.video), error: error.message };
        }
    });

    return Promise.all(tasks);
}

// 主处理函数
async function batchProcess(inputDir, outputDir) {
    try {
        await fs.mkdir(outputDir, { recursive: true });

        const matches = await findMatchingFiles(inputDir);
        if (matches.length === 0) {
            console.log('没有找到匹配的视频和字幕文件对！');
            return;
        }

        STATUS.total = matches.length;
        STATUS.completed = 0;
        STATUS.inProgress.clear();
        STATUS.results.clear();

        console.log(`找到 ${matches.length} 对匹配的文件`);
        console.log(`使用编码器: ${CONFIG.encoding.getEncoder()}\n`);

        // 每批处理10个文件
        const BATCH_SIZE = 10;
        let currentIndex = 0;

        while (currentIndex < matches.length) {
            const currentBatch = matches.slice(currentIndex, currentIndex + BATCH_SIZE);
            console.log(`\n开始处理第 ${currentIndex + 1} 到 ${Math.min(currentIndex + BATCH_SIZE, matches.length)} 个文件`);

            const results = await processBatch(matches, outputDir, currentIndex, currentIndex + BATCH_SIZE);
            
            const batchSuccessful = results.filter(r => r.success);
            const batchFailed = results.filter(r => !r.success);

            console.log('\n当前批次处理完成:');
            console.log(`成功: ${batchSuccessful.length} 个`);
            console.log(`失败: ${batchFailed.length} 个`);

            if (batchFailed.length > 0) {
                console.log('\n本批次失败文件:');
                batchFailed.forEach((item, index) => {
                    console.log(`${index + 1}. ${item.file}`);
                    console.log(`   错误: ${item.error}`);
                });
            }

            currentIndex += BATCH_SIZE;

            // 如果还有未处理的文件，等待用户确认继续
            if (currentIndex < matches.length) {
                await new Promise(resolve => {
                    console.log('\n按回车键继续处理下一批文件...');
                    process.stdin.once('data', () => resolve());
                });
            }
        }

        // 最终统计
        console.log('\n所有文件处理完成统计:');
        console.log(`总计: ${matches.length} 个文件`);
        console.log(`成功: ${Array.from(STATUS.results.values()).filter(success => success).length} 个`);
        console.log(`失败: ${Array.from(STATUS.results.values()).filter(success => !success).length} 个`);

    } catch (error) {
        console.error('处理过程中发生错误:', error);
    }
}

// 主函数
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length !== 2) {
        console.log('用法: node bin.js <输入目录> <输出目录>');
        console.log('示例: node bin.js ./videos ./output');
        process.exit(1);
    }

    const [inputDir, outputDir] = args;

    try {
        const inputStats = await fs.stat(inputDir);
        if (!inputStats.isDirectory()) {
            throw new Error('输入路径不是目录');
        }
        await batchProcess(inputDir, outputDir);
    } catch (error) {
        console.error('错误:', error.message);
        process.exit(1);
    }
}

// 运行脚本
main();