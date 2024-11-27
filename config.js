const os = require('os');

module.exports = {
    // 并发数（CPU核心数-1）
    concurrency: Math.max(1, os.cpus().length - 1),
    
    // 字幕样式
    subtitleStyle: 'FontName=Microsoft YaHei,FontSize=24,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2',
    
    // 支持的文件格式
    videoExtensions: ['.mp4', '.mkv', '.avi', '.mov'],
    subtitleExtensions: ['.srt'],
    
    // 编码配置
    encoding: {
         // 自动选择编码器
         getEncoder: () => 'libx264',
        preset: 'ultrafast',    // 编码速度预设
        crf: '28',            // 质量控制
        threads: '0'          // 0表示自动选择线程数
    }
};