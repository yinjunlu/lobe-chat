import { notification } from '@/components/AntdStaticMethods';
import { ExportDatabaseData } from '@/types/export';

export const parseConfigFile = async (file: File): Promise<ExportDatabaseData | undefined> => {
  const text = await file.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(error);
    notification.error({
      description: `出错原因: ${(error as Error).message}`,
      message: '导入失败',
    });
  }
};
