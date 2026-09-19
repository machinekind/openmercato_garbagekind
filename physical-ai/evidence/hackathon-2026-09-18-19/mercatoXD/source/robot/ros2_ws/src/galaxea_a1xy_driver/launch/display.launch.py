"""Live arm in RViz: driver -> /joint_states -> robot_state_publisher -> RViz."""
import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    desc = get_package_share_directory('galaxea_a1xy_description')
    urdf = os.path.join(desc, 'urdf', 'a1x.urdf')
    with open(urdf, 'r') as f:
        robot_description = f.read()

    return LaunchDescription([
        DeclareLaunchArgument('can_interface', default_value='can0'),
        Node(
            package='galaxea_a1xy_driver', executable='driver_node',
            name='a1xy_driver', output='screen',
            parameters=[{'can_interface': LaunchConfiguration('can_interface'),
                         'command_can_id': -1}],
        ),
        Node(
            package='robot_state_publisher', executable='robot_state_publisher',
            name='robot_state_publisher', output='screen',
            parameters=[{'robot_description': robot_description}],
        ),
        Node(package='rviz2', executable='rviz2', name='rviz2', output='screen'),
    ])
