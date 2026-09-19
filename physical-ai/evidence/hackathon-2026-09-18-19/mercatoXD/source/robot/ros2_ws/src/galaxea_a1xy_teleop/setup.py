from setuptools import setup
from glob import glob

package_name = 'galaxea_a1xy_teleop'

setup(
    name=package_name,
    version='0.1.0',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        ('share/' + package_name + '/launch', glob('launch/*.launch.py')),
        ('share/' + package_name + '/config', glob('config/*')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='v1',
    maintainer_email='prog74194@gmail.com',
    description='Arm-to-arm teleoperation for two Galaxea A1X arms.',
    license='Proprietary',
    entry_points={
        'console_scripts': [
            'teleop_node = galaxea_a1xy_teleop.teleop_node:main',
        ],
    },
)
