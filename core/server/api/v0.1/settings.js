// # Settings API
// RESTful API for the Setting resource
const Promise = require('bluebird'),
    _ = require('lodash'),
    moment = require('moment-timezone'),
    fs = require('fs-extra'),
    path = require('path'),
    config = require('../../config'),
    models = require('../../models'),
    canThis = require('../../services/permissions').canThis,
    localUtils = require('./utils'),
    urlService = require('../../../frontend/services/url'),
    common = require('../../lib/common'),
    settingsCache = require('../../services/settings/cache'),
    docName = 'settings';

let settings,
    settingsFilter,
    settingsResult,
    canEditAllSettings;

// ## Helpers

/**
 * ### Settings Filter
 * Filters an object based on a given filter object
 * @private
 * @param {Object} settings
 * @param {String} filter
 * @returns {*}
 */
settingsFilter = (settings, filter) => {
    let filteredTypes = filter ? filter.split(',') : false;
    return _.filter(settings, (setting) => {
        if (filteredTypes) {
            return _.includes(filteredTypes, setting.type);
        }

        return true;
    });
};

/**
 * ### Settings Result
 *
 * Takes a keyed JSON object
 * E.g.
 * db_hash: {
 *   id: '123abc',
 *   key: 'dbash',
 *   value: 'xxxx',
 *   type: 'core',
 *   timestamps
 *  }
 *
 *  Performs a filter, based on the `type`
 *  And converts the remaining items to our API format by adding a `setting` and `meta` keys.
 *
 * @private
 * @param {Object} settings - a keyed JSON object
 * @param {String} type
 * @returns {{settings: *}}
 */
settingsResult = (settings, type) => {
    let filteredSettings = _.values(settingsFilter(settings, type)),
        result = {
            settings: filteredSettings,
            meta: {}
        };

    if (type) {
        result.meta.filters = {
            type: type
        };
    }

    return result;
};

/**
 * ### Can Edit All Settings
 * Check that this edit request is allowed for all settings requested to be updated
 * @private
 * @param {Object} settingsInfo
 * @returns {*}
 */
canEditAllSettings = (settingsInfo, options) => {
    let checkSettingPermissions = (setting) => {
            if (setting.type === 'core' && !(options.context && options.context.internal)) {
                return Promise.reject(
                    new common.errors.NoPermissionError({message: common.i18n.t('errors.api.settings.accessCoreSettingFromExtReq')})
                );
            }

            return canThis(options.context).edit.setting(setting.key).catch(() => {
                return Promise.reject(new common.errors.NoPermissionError({message: common.i18n.t('errors.api.settings.noPermissionToEditSettings')}));
            });
        },
        checks = settingsInfo.map((settingInfo) => {
            let setting = settingsCache.get(settingInfo.key, {resolve: false});

            if (!setting) {
                return Promise.reject(new common.errors.NotFoundError(
                    {message: common.i18n.t('errors.api.settings.problemFindingSetting', {key: settingInfo.key})}
                ));
            }

            if (setting.key === 'active_theme') {
                return Promise.reject(
                    new common.errors.BadRequestError({
                        message: common.i18n.t('errors.api.settings.activeThemeSetViaAPI.error'),
                        help: common.i18n.t('errors.api.settings.activeThemeSetViaAPI.help')
                    })
                );
            }

            return checkSettingPermissions(setting);
        });

    return Promise.all(checks);
};

/**
 * ## Settings API Methods
 *
 * **See:** [API Methods](constants.js.html#api%20methods)
 */
settings = {

    /**
     * ### Browse
     * @param {Object} options
     * @returns {*}
     */
    browse(options) {
        options = options || {};

        let result = settingsResult(settingsCache.getAll(), options.type);

        // If there is no context, return only blog settings
        if (!options.context) {
            return Promise.resolve(result.settings.filter((setting) => {
                return setting.type === 'blog';
            }));
        }

        // Otherwise return whatever this context is allowed to browse
        return canThis(options.context).browse.setting().then(() => {
            // Omit core settings unless internal request
            if (!options.context.internal) {
                result.settings = result.settings.filter((setting) => {
                    return setting.type !== 'core' && setting.key !== 'permalinks';
                });
            }

            return result;
        });
    },

    /**
     * ### Read
     * @param {Object} options
     * @returns {*}
     */
    read(options) {
        if (_.isString(options)) {
            options = {key: options};
        }

        let setting = settingsCache.get(options.key, {resolve: false}),
            result = {};

        if (!setting) {
            return Promise.reject(new common.errors.NotFoundError(
                {message: common.i18n.t('errors.api.settings.problemFindingSetting', {key: options.key})}
            ));
        }

        result[options.key] = setting;

        if (setting.type === 'core' && !(options.context && options.context.internal)) {
            return Promise.reject(
                new common.errors.NoPermissionError({message: common.i18n.t('errors.api.settings.accessCoreSettingFromExtReq')})
            );
        }

        if (setting.key === 'permalinks') {
            return Promise.reject(new common.errors.NotFoundError({
                message: common.i18n.t('errors.errors.resourceNotFound')
            }));
        }

        if (setting.type === 'blog') {
            return Promise.resolve(settingsResult(result));
        }

        return canThis(options.context).read.setting(options.key).then(() => {
            return settingsResult(result);
        }, () => {
            return Promise.reject(new common.errors.NoPermissionError({message: common.i18n.t('errors.api.settings.noPermissionToReadSettings')}));
        });
    },

    /**
     * ### Edit
     * Update properties of a setting
     * @param {{settings: }} object Setting or a single string name
     * @param {{id (required), include,...}} options (optional) or a single string value
     * @return {Promise(Setting)} Edited Setting
     */
    edit(object, options) {
        options = options || {};
        let type;

        // Allow shorthand syntax where a single key and value are passed to edit instead of object and options
        if (_.isString(object)) {
            object = {settings: [{key: object, value: options}]};
        }

        // clean data
        object.settings.forEach((setting) => {
            if (!_.isString(setting.value)) {
                setting.value = JSON.stringify(setting.value);
            }
        });

        type = object.settings.find((setting) => {
            return setting.key === 'type';
        });

        if (_.isObject(type)) {
            type = type.value;
        }

        object.settings = _.reject(object.settings, (setting) => {
            return setting.key === 'type';
        });

        if (object.settings[0].key === 'permalinks') {
            return Promise.reject(new common.errors.NotFoundError({
                message: common.i18n.t('errors.errors.resourceNotFound')
            }));
        }

        return canEditAllSettings(object.settings, options).then(() => {
            return localUtils.checkObject(object, docName).then((checkedData) => {
                return models.Settings.edit(checkedData.settings, options);
            }).then((settingsModelsArray) => {
                // Instead of a standard bookshelf collection, Settings.edit returns an array of Settings Models.
                // We convert this to JSON, by calling toJSON on each Model (using invokeMap for ease)
                // We use keyBy to create an object that uses the 'key' as a key for each setting.
                let settingsKeyedJSON = _.keyBy(_.invokeMap(settingsModelsArray, 'toJSON'), 'key');
                return settingsResult(settingsKeyedJSON, type);
            });
        });
    },

    /**
     * The `routes.yaml` file offers a way to configure your Ghost blog. It's currently a setting feature
     * we have added. That's why the `routes.yaml` file is treated as a "setting" right now.
     * If we want to add single permissions for this file (e.g. upload/download routes.yaml), we can add later.
     *
     * How does it work?
     *
     * - we first reset all url generators (each url generator belongs to one express router)
     *   - we don't destroy the resources, we only release them (this avoids reloading all resources from the db again)
     * - then we reload the whole site app, which will reset all routers and re-create the url generators
     */
    upload(options) {
        const backupRoutesPath = path.join(config.getContentPath('settings'), `routes-${moment().format('YYYY-MM-DD-HH-mm-ss')}.yaml`);

        return localUtils.handlePermissions('settings', 'edit')(options)
            .then(() => {
                return fs.copy(`${config.getContentPath('settings')}/routes.yaml`, backupRoutesPath);
            })
            .then(() => {
                return fs.copy(options.path, `${config.getContentPath('settings')}/routes.yaml`);
            })
            .then(() => {
                urlService.resetGenerators({releaseResourcesOnly: true});
            })
            .then(() => {
                const siteApp = require('../../web/site/app');

                try {
                    return siteApp.reload();
                } catch (err) {
                    // bring back backup, otherwise your Ghost blog is broken
                    return fs.copy(backupRoutesPath, `${config.getContentPath('settings')}/routes.yaml`)
                        .then(() => {
                            return siteApp.reload();
                        })
                        .then(() => {
                            throw err;
                        });
                }
            });
    },

    download(options) {
        const routesPath = path.join(config.getContentPath('settings'), 'routes.yaml');

        return localUtils.handlePermissions('settings', 'browse')(options)
            .then(() => {
                return fs.readFile(routesPath, 'utf-8');
            })
            .catch((err) => {
                if (err.code === 'ENOENT') {
                    return Promise.resolve([]);
                }

                if (common.errors.utils.isIgnitionError(err)) {
                    throw err;
                }

                throw new common.errors.NotFoundError({
                    err: err
                });
            });
    }
};

module.exports = settings;
