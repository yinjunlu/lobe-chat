import { sql } from 'drizzle-orm';
import { and, eq, inArray } from 'drizzle-orm/expressions';

import {
  agents,
  agentsToSessions,
  messagePlugins,
  messageTranslates,
  messages,
  sessionGroups,
  sessions,
  topics,
} from '@/database/schemas';
import * as SCHEMAS from '@/database/schemas';
import { LobeChatDatabase } from '@/database/type';
import { ImportResult } from '@/services/import/_deprecated';
import { ExportDatabaseData } from '@/types/export';
import { ImporterEntryData } from '@/types/importer';
import { sanitizeUTF8 } from '@/utils/sanitizeUTF8';

// 导入模式
export enum ImportMode {
  OVERRIDE = 'override',
  SKIP = 'skip',
}

export class DataImporterRepos {
  private userId: string;
  private db: LobeChatDatabase;

  /**
   * The version of the importer that this module supports
   */
  supportVersion = 7;

  constructor(db: LobeChatDatabase, userId: string) {
    this.userId = userId;
    this.db = db;
  }

  importData = async (data: ImporterEntryData) => {
    if (data.version > this.supportVersion) throw new Error('Unsupported version');

    let sessionGroupResult: ImportResult = { added: 0, errors: 0, skips: 0 };
    let sessionResult: ImportResult = { added: 0, errors: 0, skips: 0 };
    let topicResult: ImportResult = { added: 0, errors: 0, skips: 0 };
    let messageResult: ImportResult = { added: 0, errors: 0, skips: 0 };

    let sessionGroupIdMap: Record<string, string> = {};
    let sessionIdMap: Record<string, string> = {};
    let topicIdMap: Record<string, string> = {};

    await this.db.transaction(async (trx) => {
      // import sessionGroups
      if (data.sessionGroups && data.sessionGroups.length > 0) {
        const query = await trx.query.sessionGroups.findMany({
          where: and(
            eq(sessionGroups.userId, this.userId),
            inArray(
              sessionGroups.clientId,
              data.sessionGroups.map(({ id }) => id),
            ),
          ),
        });

        sessionGroupResult.skips = query.length;

        const mapArray = await trx
          .insert(sessionGroups)
          .values(
            data.sessionGroups.map(({ id, createdAt, updatedAt, ...res }) => ({
              ...res,
              clientId: id,
              createdAt: new Date(createdAt),
              updatedAt: new Date(updatedAt),
              userId: this.userId,
            })),
          )
          .onConflictDoUpdate({
            set: { updatedAt: new Date() },
            target: [sessionGroups.clientId, sessionGroups.userId],
          })
          .returning({ clientId: sessionGroups.clientId, id: sessionGroups.id });

        sessionGroupResult.added = mapArray.length - query.length;

        sessionGroupIdMap = Object.fromEntries(mapArray.map(({ clientId, id }) => [clientId, id]));
      }

      // import sessions
      if (data.sessions && data.sessions.length > 0) {
        const query = await trx.query.sessions.findMany({
          where: and(
            eq(sessions.userId, this.userId),
            inArray(
              sessions.clientId,
              data.sessions.map(({ id }) => id),
            ),
          ),
        });

        sessionResult.skips = query.length;

        const mapArray = await trx
          .insert(sessions)
          .values(
            data.sessions.map(({ id, createdAt, updatedAt, group, ...res }) => ({
              ...res,
              clientId: id,
              createdAt: new Date(createdAt),
              groupId: group ? sessionGroupIdMap[group] : null,
              updatedAt: new Date(updatedAt),
              userId: this.userId,
            })),
          )
          .onConflictDoUpdate({
            set: { updatedAt: new Date() },
            target: [sessions.clientId, sessions.userId],
          })
          .returning({ clientId: sessions.clientId, id: sessions.id });

        // get the session client-server id map
        sessionIdMap = Object.fromEntries(mapArray.map(({ clientId, id }) => [clientId, id]));

        // update added count
        sessionResult.added = mapArray.length - query.length;

        const shouldInsertSessionAgents = data.sessions
          // filter out existing session, only insert new ones
          .filter((s) => query.every((q) => q.clientId !== s.id));

        // 只有当需要有新的 session 时，才会插入 agent
        if (shouldInsertSessionAgents.length > 0) {
          const agentMapArray = await trx
            .insert(agents)
            .values(
              shouldInsertSessionAgents.map(({ config, meta }) => ({
                ...config,
                ...meta,
                userId: this.userId,
              })),
            )
            .returning({ id: agents.id });

          await trx.insert(agentsToSessions).values(
            shouldInsertSessionAgents.map(({ id }, index) => ({
              agentId: agentMapArray[index].id,
              sessionId: sessionIdMap[id],
              userId: this.userId,
            })),
          );
        }
      }

      // import topics
      if (data.topics && data.topics.length > 0) {
        const skipQuery = await trx.query.topics.findMany({
          where: and(
            eq(topics.userId, this.userId),
            inArray(
              topics.clientId,
              data.topics.map(({ id }) => id),
            ),
          ),
        });
        topicResult.skips = skipQuery.length;

        const mapArray = await trx
          .insert(topics)
          .values(
            data.topics.map(({ id, createdAt, updatedAt, sessionId, favorite, ...res }) => ({
              ...res,
              clientId: id,
              createdAt: new Date(createdAt),
              favorite: Boolean(favorite),
              sessionId: sessionId ? sessionIdMap[sessionId] : null,
              updatedAt: new Date(updatedAt),
              userId: this.userId,
            })),
          )
          .onConflictDoUpdate({
            set: { updatedAt: new Date() },
            target: [topics.clientId, topics.userId],
          })
          .returning({ clientId: topics.clientId, id: topics.id });

        topicIdMap = Object.fromEntries(mapArray.map(({ clientId, id }) => [clientId, id]));

        topicResult.added = mapArray.length - skipQuery.length;
      }

      // import messages
      if (data.messages && data.messages.length > 0) {
        // 1. find skip ones
        console.time('find messages');
        const skipQuery = await trx.query.messages.findMany({
          where: and(
            eq(messages.userId, this.userId),
            inArray(
              messages.clientId,
              data.messages.map(({ id }) => id),
            ),
          ),
        });
        console.timeEnd('find messages');

        messageResult.skips = skipQuery.length;

        // filter out existing messages, only insert new ones
        const shouldInsertMessages = data.messages.filter((s) =>
          skipQuery.every((q) => q.clientId !== s.id),
        );

        // 2. insert messages
        if (shouldInsertMessages.length > 0) {
          const inertValues = shouldInsertMessages.map(
            ({ id, extra, createdAt, updatedAt, sessionId, topicId, content, ...res }) => ({
              ...res,
              clientId: id,
              content: sanitizeUTF8(content),
              createdAt: new Date(createdAt),
              model: extra?.fromModel,
              parentId: null,
              provider: extra?.fromProvider,
              sessionId: sessionId ? sessionIdMap[sessionId] : null,
              topicId: topicId ? topicIdMap[topicId] : null, // 暂时设为 NULL
              updatedAt: new Date(updatedAt),
              userId: this.userId,
            }),
          );

          console.time('insert messages');
          const BATCH_SIZE = 100; // 每批次插入的记录数

          for (let i = 0; i < inertValues.length; i += BATCH_SIZE) {
            const batch = inertValues.slice(i, i + BATCH_SIZE);
            await trx.insert(messages).values(batch);
          }

          console.timeEnd('insert messages');

          const messageIdArray = await trx
            .select({ clientId: messages.clientId, id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.userId, this.userId),
                inArray(
                  messages.clientId,
                  data.messages.map(({ id }) => id),
                ),
              ),
            );

          const messageIdMap = Object.fromEntries(
            messageIdArray.map(({ clientId, id }) => [clientId, id]),
          );

          // 3. update parentId for messages
          console.time('execute updates parentId');
          const parentIdUpdates = shouldInsertMessages
            .filter((msg) => msg.parentId) // 只处理有 parentId 的消息
            .map((msg) => {
              if (messageIdMap[msg.parentId as string])
                return sql`WHEN ${messages.clientId} = ${msg.id} THEN ${messageIdMap[msg.parentId as string]} `;

              return undefined;
            })
            .filter(Boolean);

          if (parentIdUpdates.length > 0) {
            await trx
              .update(messages)
              .set({
                parentId: sql`CASE ${sql.join(parentIdUpdates)} END`,
              })
              .where(
                inArray(
                  messages.clientId,
                  data.messages.map((msg) => msg.id),
                ),
              );

            // if needed, you can print the sql and params
            // const SQL = updateQuery.toSQL();
            // console.log('sql:', SQL.sql);
            // console.log('params:', SQL.params);
          }
          console.timeEnd('execute updates parentId');

          // 4. insert message plugins
          const pluginInserts = shouldInsertMessages.filter((msg) => msg.plugin);
          if (pluginInserts.length > 0) {
            await trx.insert(messagePlugins).values(
              pluginInserts.map((msg) => ({
                apiName: msg.plugin?.apiName,
                arguments: msg.plugin?.arguments,
                id: messageIdMap[msg.id],
                identifier: msg.plugin?.identifier,
                state: msg.pluginState,
                toolCallId: msg.tool_call_id,
                type: msg.plugin?.type,
                userId: this.userId,
              })),
            );
          }

          // 5. insert message translate
          const translateInserts = shouldInsertMessages.filter((msg) => msg.extra?.translate);
          if (translateInserts.length > 0) {
            await trx.insert(messageTranslates).values(
              translateInserts.map((msg) => ({
                id: messageIdMap[msg.id],
                ...msg.extra?.translate,
                userId: this.userId,
              })),
            );
          }

          // TODO: 未来需要处理 TTS 和图片的插入 （目前存在 file 的部分，不方便处理）
        }

        messageResult.added = shouldInsertMessages.length;
      }
    });

    return {
      messages: messageResult,
      sessionGroups: sessionGroupResult,
      sessions: sessionResult,
      topics: topicResult,
    };
  };

  /**
   * 导入 pg 导出的数据（不包含文件相关表）
   */
  async importPgData(
    dbData: ExportDatabaseData,
    mode: ImportMode = ImportMode.SKIP,
  ): Promise<Record<string, ImportResult>> {
    // 定义表处理顺序（基于依赖关系）
    const tableOrder = [
      'users',
      'userSettings',
      'userInstalledPlugins',
      'aiProviders',
      'aiModels',
      'sessionGroups',
      'sessions',
      'agents',
      'agentsToSessions',
      'topics',
      'messages',
      'messagePlugins',
      'messageTranslates',
      'messageTTS',
      'threads',
    ];

    // 结果统计对象
    const results: Record<string, ImportResult> = {};

    // 使用单一事务包装整个导入过程
    await this.db.transaction(async (trx) => {
      console.log(`Starting data import transaction (mode: ${mode})`);

      const pgData = dbData.data;
      // 初始化 ID 映射表
      const idMappings: Record<string, Record<string, string>> = {};
      Object.entries(pgData).forEach(([table, records]) => {
        if (records.length > 0) {
          idMappings[table] = {};
        }
      });

      // 按顺序处理每个表
      for (const tableName of tableOrder) {
        if (!pgData[tableName] || pgData[tableName].length === 0) continue;

        console.log(`Processing table: ${tableName} (${pgData[tableName].length} records)`);

        try {
          // 特殊表处理
          if (tableName === 'messages') {
            results[tableName] = await this.processMessages(
              pgData[tableName],
              trx,
              idMappings,
              mode,
            );
          }
          // 标准表处理
          else {
            results[tableName] = await this.processTable(
              tableName,
              pgData[tableName],
              trx,
              idMappings,
              mode,
            );
          }

          console.log(
            `Completed table ${tableName}: added=${results[tableName].added}, skips=${results[tableName].skips}, updated=${results[tableName].updated || 0}`,
          );
        } catch (error) {
          console.error(`Error processing table ${tableName}:`, error);
          results[tableName] = { added: 0, errors: 1, skips: 0 };
        }
      }

      console.log('Data import transaction completed successfully');
    });

    return results;
  }

  /**
   * 处理标准表数据
   */
  private async processTable(
    tableName: string,
    data: any[],
    trx: any,
    idMappings: Record<string, Record<string, string>>,
    mode: ImportMode,
  ): Promise<ImportResult> {
    const result: ImportResult = { added: 0, errors: 0, skips: 0, updated: 0 };

    if (!SCHEMAS[tableName]) {
      console.warn(`Schema not found for table: ${tableName}`);
      result.errors = 1;
      return result;
    }

    const tableSchema = SCHEMAS[tableName];

    // 1. 检查已存在的记录（基于 clientId 和 user_id）
    const existingRecords = await trx.query[tableName].findMany({
      where: and(
        eq(tableSchema.userId, this.userId),
        inArray(
          tableSchema.clientId,
          data.map((item) => item.clientId || item.id), // 支持原始 id 或已有 clientId
        ),
      ),
    });

    // 获取已存在记录的 clientId 映射
    const existingClientIdMap = new Map(existingRecords.map((record) => [record.clientId, record]));

    // 2. 根据模式处理数据
    let recordsToInsert = [];
    let recordsToUpdate = [];

    for (const item of data) {
      const clientId = item.clientId || item.id;
      const existing = existingClientIdMap.get(clientId);

      // 准备记录数据
      const recordData = this.prepareRecordData(tableName, item, idMappings);

      if (existing) {
        // 记录已存在
        if (mode === ImportMode.OVERRIDE) {
          // 覆盖模式：更新记录
          recordsToUpdate.push({ data: recordData, id: existing.id });
        } else {
          // 跳过模式：记录跳过
          result.skips++;
        }

        // 无论是否更新，都需要添加到 ID 映射
        idMappings[tableName][clientId] = existing.id;
      } else {
        // 记录不存在：插入新记录
        recordsToInsert.push(recordData);
      }
    }

    // 3. 插入新记录
    if (recordsToInsert.length > 0) {
      const insertedRecords = await trx
        .insert(tableSchema)
        .values(recordsToInsert)
        .returning({ newId: tableSchema.id, originalId: tableSchema.clientId });

      // 更新 ID 映射表
      insertedRecords.forEach((record) => {
        idMappings[tableName][record.originalId] = record.newId;
      });

      result.added = insertedRecords.length;
    }

    // 4. 更新现有记录（如果是覆盖模式）
    if (recordsToUpdate.length > 0) {
      for (const record of recordsToUpdate) {
        await trx
          .update(tableSchema)
          .set({ ...record.data, updatedAt: new Date() })
          .where(eq(tableSchema.id, record.id));
      }

      result.updatedAt = recordsToUpdate.length;
    }

    return result;
  }

  /**
   * 准备记录数据 - 处理 ID 和外键引用
   */
  private prepareRecordData(
    tableName: string,
    item: any,
    idMappings: Record<string, Record<string, string>>,
  ): any {
    // 创建新记录对象，保留原始 ID 到 clientId
    const newItem: any = {
      ...item,
      clientId: item.clientId || item.id,
      user_id: this.userId,
    };

    // 处理日期字段
    if (newItem.created_at) newItem.created_at = new Date(newItem.created_at);
    if (newItem.updated_at) newItem.updated_at = new Date(newItem.updated_at);
    if (newItem.accessed_at) newItem.accessed_at = new Date(newItem.accessed_at);

    // 处理外键引用 - 使用映射表替换关联 ID
    Object.entries(newItem).forEach(([key, value]) => {
      // 跳过 id, clientId, user_id 字段
      if (key === 'id' || key === 'clientId' || key === 'userId') return;

      // 处理外键字段 (以 Id 结尾且不是主键)
      if (key.endsWith('Id') && value) {
        const refTableName = this.getReferenceTableName(tableName, key);
        if (refTableName && idMappings[refTableName] && idMappings[refTableName][value as string]) {
          newItem[key] = idMappings[refTableName][value as string];
        }
      }
    });

    // 删除原始 id 字段，让数据库生成新 id
    delete newItem.id;

    return newItem;
  }

  /**
   * 处理 messages 表的特殊情况
   */
  private async processMessages(
    messages: any[],
    trx: any,
    idMappings: Record<string, Record<string, string>>,
    mode: ImportMode,
  ): Promise<ImportResult> {
    // 1. 先处理所有消息，暂时将 parentId 设为 null
    const messagesWithoutParent = messages.map((msg) => {
      const newMsg = { ...msg };
      // 保存原始 parentId 到临时字段
      if (newMsg.parentId) {
        newMsg._original_parentId = newMsg.parentId;
        newMsg.parentId = null;
      }
      return newMsg;
    });

    // 2. 插入所有消息
    const result = await this.processTable(
      'messages',
      messagesWithoutParent,
      trx,
      idMappings,
      mode,
    );

    // 3. 更新 parentId 关系
    const parentUpdates = messages
      .filter((msg) => msg.parentId)
      .map((msg) => {
        const clientId = msg.id || msg.clientId;
        const parentClientId = msg.parentId;

        const newMessageId = idMappings.messages[clientId];
        const newParentId = idMappings.messages[parentClientId];

        if (newMessageId && newParentId) {
          return {
            messageId: newMessageId,
            parentId: newParentId,
          };
        }
        return null;
      })
      .filter(Boolean);

    // 批量更新 parentId
    if (parentUpdates.length > 0) {
      console.log(`Updating ${parentUpdates.length} parent-child relationships for messages`);

      // 使用 CASE 语句构建批量更新
      const caseStatements = parentUpdates.map(
        (update) => sql`WHEN ${SCHEMAS.messages.id} = ${update.messageId} THEN ${update.parentId}`,
      );

      await trx
        .update(SCHEMAS.messages)
        .set({
          parentId: sql`CASE ${sql.join(caseStatements)} ELSE ${SCHEMAS.messages.parentId} END`,
        })
        .where(
          inArray(
            SCHEMAS.messages.id,
            parentUpdates.map((update) => update.messageId),
          ),
        );
    }

    return result;
  }

  /**
   * 获取引用表名
   * 根据字段名和表名推断引用的表
   */
  private getReferenceTableName(tableName: string, fieldName: string): string | null {
    // 特殊情况处理
    const specialCases: Record<string, Record<string, string>> = {
      agentsToSessions: {
        agent_id: 'agents',
        session_id: 'sessions',
      },
      messages: {
        agent_id: 'agents',
        parentId: 'messages',
        session_id: 'sessions',
        topic_id: 'topics',
      },
      sessions: {
        group_id: 'sessionGroups',
      },
      topics: {
        session_id: 'sessions',
      },
    };

    // 检查特殊情况
    if (specialCases[tableName] && specialCases[tableName][fieldName]) {
      return specialCases[tableName][fieldName];
    }

    // 通用情况 - 根据字段名推断表名
    // 例如：session_id -> sessions, topic_id -> topics
    const baseFieldName = fieldName.replace('_id', '');

    // 处理复数形式
    if (baseFieldName === 'agent') return 'agents';
    if (baseFieldName === 'message') return 'messages';
    if (baseFieldName === 'session') return 'sessions';
    if (baseFieldName === 'topic') return 'topics';

    // 如果无法推断，返回 null
    return null;
  }
}
