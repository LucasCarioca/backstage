/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Knex from 'knex';
import lodash from 'lodash';
import path from 'path';
import { Logger } from 'winston';
import { DescriptorParser, LocationReader, ParserError } from '../ingestion';
import { Database } from './Database';
import { DatabaseLocationUpdateLogStatus } from './types';
import { DescriptorEnvelope } from '../ingestion/descriptors/types';

export class DatabaseManager {
  public static async createDatabase(database: Knex): Promise<Database> {
    await database.migrate.latest({
      directory: path.resolve(__dirname, 'migrations'),
      loadExtensions: ['.js'],
    });
    return new Database(database);
  }

  private static async logUpdateSuccess(
    database: Database,
    locationId: string,
    componentName?: string,
  ) {
    return database.addLocationUpdateLogEvent(
      locationId,
      DatabaseLocationUpdateLogStatus.SUCCESS,
      componentName,
    );
  }

  private static async logUpdateFailure(
    database: Database,
    locationId: string,
    error?: Error,
    componentName?: string,
  ) {
    return database.addLocationUpdateLogEvent(
      locationId,
      DatabaseLocationUpdateLogStatus.FAIL,
      componentName,
      error?.message,
    );
  }

  public static async refreshLocations(
    database: Database,
    reader: LocationReader,
    parser: DescriptorParser,
    logger: Logger,
  ): Promise<void> {
    const locations = await database.locations();
    for (const location of locations) {
      try {
        logger.debug(
          `Refreshing location id="${location.id}" type="${location.type}" target="${location.target}"`,
        );

        const readerOutput = await reader.read(location.type, location.target);

        for (const readerItem of readerOutput) {
          if (readerItem.type === 'error') {
            logger.debug(readerItem.error);
            continue;
          }

          try {
            const parserOutput = await parser.parse(readerItem.data);
            if (parserOutput.kind === 'Component') {
              await DatabaseManager.refreshSingleEntity(
                database,
                location.id,
                parserOutput.component,
              );
              await DatabaseManager.logUpdateSuccess(
                database,
                location.id,
                parserOutput.component.metadata!.name,
              );
            }
          } catch (error) {
            let componentName;
            if (error instanceof ParserError) {
              componentName = error.componentName;
            }
            await DatabaseManager.logUpdateFailure(
              database,
              location.id,
              error,
              componentName,
            );
          }
        }
        await DatabaseManager.logUpdateSuccess(database, location.id);
      } catch (error) {
        logger.debug(`Failed to refresh location ${location.id}, ${error}`);
        await DatabaseManager.logUpdateFailure(database, location.id, error);
      }
    }
  }

  private static async refreshSingleEntity(
    database: Database,
    locationId: string,
    entity: DescriptorEnvelope,
  ): Promise<void> {
    const { name, namespace } = entity.metadata || {};
    if (!name) {
      throw new Error('Entities without names are not yet supported');
    }

    await database.transaction(async tx => {
      const previous = await database.entity(tx, name, namespace);
      if (previous) {
        const merged = DatabaseManager.mergeEntities(previous.entity, entity);
        await database.updateEntity(tx, {
          locationId: locationId,
          entity: merged,
        });
      } else {
        await database.addEntity(tx, { locationId: locationId, entity });
      }
    });
  }

  private static mergeEntities(
    base: DescriptorEnvelope,
    added: DescriptorEnvelope,
  ): DescriptorEnvelope {
    let result = lodash.cloneDeep(added);

    // The added thing is not supposed to have a uid or generation, but we
    // want to keep the ones from the original to make updates work
    result = lodash.merge(result, {
      metadata: {
        uid: base.metadata?.uid,
        generation: base.metadata?.generation,
      },
    });

    // Annotations get special treatment; we want to merge the original ones
    // with the new ones
    if (base.metadata?.annotations) {
      result = lodash.merge(
        {
          metadata: {
            annotations: base.metadata.annotations,
          },
        },
        result,
      );
    }

    return result;
  }
}
