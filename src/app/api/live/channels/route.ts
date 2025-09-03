import { NextRequest, NextResponse } from 'next/server';

import { getStorage } from '@/lib/db';
import { fetchAndParseM3U } from '@/lib/m3u-parser';

// 针对不同部署模式的配置
export const runtime = process.env.CLOUDFLARE_PAGES === '1' ? 'edge' : 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const sourceKey = url.searchParams.get('source');

    if (!sourceKey) {
      return NextResponse.json({ error: '缺少直播源参数' }, { status: 400 });
    }

    const storage = getStorage();
    
    // 获取直播源配置
    const liveConfigs = await storage.getLiveConfigs();
    const liveSource = liveConfigs.find(config => config.key === sourceKey);
    
    if (!liveSource) {
      return NextResponse.json({ error: '直播源不存在' }, { status: 404 });
    }

    if (liveSource.disabled) {
      return NextResponse.json({ error: '直播源已禁用' }, { status: 400 });
    }

    // 检查缓存
    const cached = await storage.getCachedLiveChannels(sourceKey);
    const now = Date.now();
    
    if (cached && cached.expireTime > now) {
      return NextResponse.json({
        success: true,
        source: {
          key: liveSource.key,
          name: liveSource.name,
        },
        channels: cached.channels,
        cached: true,
        updateTime: cached.updateTime,
      });
    }

    // 获取并解析频道
    try {
      const channels = await fetchAndParseM3U(liveSource.url, liveSource.ua);
      
      // 更新缓存（缓存30分钟）
      const cacheData = {
        channels,
        updateTime: now,
        expireTime: now + 30 * 60 * 1000, // 30分钟后过期
      };
      
      await storage.setCachedLiveChannels(sourceKey, cacheData);
      
      // 更新频道数量
      const updatedConfigs = liveConfigs.map(config => 
        config.key === sourceKey 
          ? { ...config, channelNumber: channels.length }
          : config
      );
      await storage.setLiveConfigs(updatedConfigs);

      return NextResponse.json({
        success: true,
        source: {
          key: liveSource.key,
          name: liveSource.name,
        },
        channels,
        cached: false,
        updateTime: now,
      });
    } catch (parseError) {
      return NextResponse.json(
        { 
          error: `解析失败: ${parseError instanceof Error ? parseError.message : '未知错误'}` 
        },
        { status: 500 }
      );
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Live channels API error:', error);
    return NextResponse.json(
      { error: '获取频道列表失败' },
      { status: 500 }
    );
  }
}
