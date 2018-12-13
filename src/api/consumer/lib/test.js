/** @flow */
import { loadConsumer, Consumer } from '../../../consumer';
import loader from '../../../cli/loader';
import ComponentsList from '../../../consumer/component/components-list';
import { BEFORE_LOADING_COMPONENTS } from '../../../cli/loader/loader-messages';
import { TESTS_FORK_LEVEL } from '../../../constants';
import specsRunner from '../../../specs-runner/specs-runner';
import GeneralError from '../../../error/general-error';
import type { SpecsResultsWithComponentId } from '../../../consumer/specs-results/specs-results';
import pMapSeries from 'p-map-series';

import IsolatedEnvironment from '../../../environment/environment';
import promiseLimit from 'promise-limit';

import SpecsResults from '../../../consumer/specs-results/specs-results';

import type { RawTestsResults } from '../specs-results/specs-results';

const limit = promiseLimit(10);

export type ForkLevel = 'NONE' | 'ONE' | 'COMPONENT';

/**
 * Run tests for all modified components or for specific component
 * @param {string} id
 * @param {'NONE' | 'ONE' | 'COMPONENT'} forkLevel - run the tests in the current process
 * or in child process, or in child process for each component
 * @param {boolean} verbose
 */
export default (async function test(
  id?: string,
  forkLevel: ForkLevel = TESTS_FORK_LEVEL.ONE,
  includeUnmodified: boolean = false,
  verbose: ?boolean
): Promise<SpecsResultsWithComponentId> {
  if (forkLevel === TESTS_FORK_LEVEL.NONE) {
    return testInProcess(id, includeUnmodified, verbose);
  }
  if (forkLevel === TESTS_FORK_LEVEL.ONE) {
    const ids = id ? [id] : undefined;
    // $FlowFixMe
    return specsRunner({ ids, forkLevel, includeUnmodified, verbose });
  }
  if (forkLevel === TESTS_FORK_LEVEL.COMPONENT) {
    const consumer: Consumer = await loadConsumer();
    const components = await _getComponents(consumer, id, includeUnmodified, verbose);
    const ids = components.map(component => component.id.toString());
    // $FlowFixMe
    const results = await specsRunner({ ids, forkLevel, verbose });
    return results;
  }
  throw new GeneralError('unknown fork level, fork level must be one of: NONE, ONE, COMPONENT');
});

export const testInProcess = async (
  id?: string,
  includeUnmodified: boolean = false,
  verbose: ?boolean
): Promise<SpecsResultsWithComponentId> => {
  const consumer: Consumer = await loadConsumer();
  const { env, componentSandboxes } = await _getComponents(consumer, id, includeUnmodified, verbose);
  const specsResults = await Promise.all(
    componentSandboxes.map(compAndSandbox =>
      limit(async () => {
        const { component, sandbox } = compAndSandbox;
        if (component.tester && component.tester.action) {
          try {
            console.log('running tests for component:', component.name); // TODO: proper bit logging
            const rawResults: RawTestsResults[] = await component.tester.action(
              {
                files: component.files.map(file => file.clone()),
                testFiles: component.files.filter(file => file.test),
                rawConfig: component.tester.rawConfig,
                dynamicConfig: component.tester.dynamicConfig,
                configFiles: component.tester.files,
                api: component.compiler.api
              },
              sandbox.updateFs,
              sandbox.exec
            );
            if (!rawResults || !rawResults[0]) return {};
            const specs = SpecsResults.createFromRaw(rawResults[0]); // TODO: why is this an array?
            const pass = !!specs.pass;
            return { componentId: component.id, specs: [specs], pass };
          } catch (e) {
            throw new Error(`could not run tester ${e}`);
          }
        }
        return { componentId: component.id };
      })
    )
  );
  await env.destroySandboxedEnvs();
  return specsResults.filter(r => r.componentId); // TODO: what are those without an id?
};

const _getComponents = async (
  consumer: Consumer,
  id?: string,
  includeUnmodified: boolean = false,
  verbose: ?boolean
) => {
  if (id) {
    const idParsed = consumer.getParsedId(id);
    const component = await consumer.loadComponent(idParsed);
    return [component];
  }
  const componentsList = new ComponentsList(consumer);
  loader.start(BEFORE_LOADING_COMPONENTS);
  let components;
  if (includeUnmodified) {
    components = await componentsList.authoredAndImportedComponents();
  } else {
    components = await componentsList.newModifiedAndAutoTaggedComponents();
  }
  loader.stop();
  const env = new IsolatedEnvironment(consumer.scope);
  await env.create();
  const sandboxes = await Promise.all(components.map(c => env.isolateComponentToSandbox(c, components)));
  const componentSandboxes = components.map((component, index) => ({ component, sandbox: sandboxes[index] }));
  return { env, componentSandboxes };
};
