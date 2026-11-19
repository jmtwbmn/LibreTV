import { NextResponse } from 'next/server';
import { handleCmsAdapter } from '@/lib/cms-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 苹果CMS v10 采集接口适配器路由。
 *   /api/cms-adapter/<provider>[/<tag>]?ac=videolist&wd=关键词&pg=1  -> 搜索
 *   /api/cms-adapter/<provider>[/<tag>]?ac=videolist&ids=视频ID      -> 详情
 * provider: nhk | nfb | anione | links
 * Next 15：params 是 Promise，先 await 取 path 段。
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const body = await handleCmsAdapter(req, Array.isArray(path) ? path : []);
  return NextResponse.json(body, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
