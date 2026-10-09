package com.blueysoft.poc.hapi;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.beans.factory.support.GenericBeanDefinition;

class UnusedEndpointRemoverTest {

	private static void register(DefaultListableBeanFactory f, String name, String className) {
		GenericBeanDefinition d = new GenericBeanDefinition();
		d.setBeanClassName(className); // never instantiated, so the class need not exist
		f.registerBeanDefinition(name, d);
	}

	@Test
	void removesTheTwoUnusedControllersAndNothingElse() {
		DefaultListableBeanFactory f = new DefaultListableBeanFactory();
		register(f, "jobController", "ca.uhn.fhir.jpa.starter.web.JobController");
		register(f, "testerController", "ca.uhn.fhir.to.Controller");
		register(f, "keep", "ca.uhn.fhir.jpa.starter.common.StarterJpaConfig"); // positive control: others survive
		register(f, "keepToo", "ca.uhn.fhir.to.SomethingElse");
		f.registerBeanDefinition("factoryMethodBean", new GenericBeanDefinition()); // no class name, like a @Bean method

		new UnusedEndpointRemover().postProcessBeanDefinitionRegistry(f);

		assertFalse(f.containsBeanDefinition("jobController"));
		assertFalse(f.containsBeanDefinition("testerController"));
		assertTrue(f.containsBeanDefinition("keep"));
		assertTrue(f.containsBeanDefinition("keepToo"));
		assertTrue(f.containsBeanDefinition("factoryMethodBean"));
	}
}
