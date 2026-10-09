package com.blueysoft.poc.hapi;

import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.beans.factory.support.BeanDefinitionRegistry;
import org.springframework.beans.factory.support.BeanDefinitionRegistryPostProcessor;
import org.springframework.stereotype.Component;

/**
 * Removes web endpoints of the prebuilt HAPI image that nothing in this system uses and that sit OUTSIDE the FHIR
 * servlet, where no HAPI interceptor can protect them:
 * <ul>
 *   <li>{@code ca.uhn.fhir.jpa.starter.web.JobController}: {@code GET /control/jobs} (lists batch jobs) and
 *       {@code DELETE /control/jobs} (cancels one). An unconditional {@code @RestController}: no property turns it off.
 *       It answered with no token when first probed (M4).</li>
 *   <li>{@code ca.uhn.fhir.to.Controller}: the "tester" web UI at {@code /}. It is enabled whenever any
 *       {@code hapi.fhir.tester*} property exists, and the image's own defaults define them, so a config file cannot
 *       switch it off. It also makes the SERVER fetch URLs on a visitor's behalf
 *       ({@code refuse_to_fetch_third_party_urls: false} in the image defaults).</li>
 * </ul>
 * Dropping the bean definitions before instantiation means Spring MVC never maps the paths (404). Nothing calls
 * either one: no class, template or script inside the image references them, and neither do the POC's apps.
 */
@Component
public class UnusedEndpointRemover implements BeanDefinitionRegistryPostProcessor {

	private static final Logger ourLog = LoggerFactory.getLogger(UnusedEndpointRemover.class);

	static final Set<String> REMOVED_CLASSES = Set.of("ca.uhn.fhir.jpa.starter.web.JobController", "ca.uhn.fhir.to.Controller");

	@Override
	public void postProcessBeanDefinitionRegistry(BeanDefinitionRegistry theRegistry) throws BeansException {
		int removed = 0;
		for (String name : theRegistry.getBeanDefinitionNames()) {
			BeanDefinition def = theRegistry.getBeanDefinition(name);
			String className = def.getBeanClassName(); // null for factory-method (@Bean) definitions; Set.of(...).contains(null) throws
			if (className != null && REMOVED_CLASSES.contains(className)) {
				theRegistry.removeBeanDefinition(name);
				ourLog.info("Removed unused web endpoint bean '{}' ({})", name, def.getBeanClassName());
				removed++;
			}
		}
		if (removed == 0) {
			// Not fatal (a HAPI upgrade may rename or drop them), but loud: the live checks assert the paths are 404.
			ourLog.warn("UnusedEndpointRemover matched no bean definitions; was HAPI upgraded? Re-check /control/jobs and / ");
		}
	}

	@Override
	public void postProcessBeanFactory(ConfigurableListableBeanFactory theBeanFactory) throws BeansException {
		// nothing to do
	}
}
